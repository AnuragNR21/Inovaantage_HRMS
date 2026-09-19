const db = require('../db');

async function ensurePendingForRun(conn, runId) {
  await conn.execute(
    `MERGE INTO payslip_documents d
     USING (
       SELECT p.payroll_id, p.run_id, p.employee_id
         FROM payroll p JOIN payroll_runs r ON r.run_id = p.run_id
        WHERE p.run_id = :runId AND r.status = 'FINALIZED'
          AND p.approval_status <> 'HOLD'
     ) source
        ON (d.payroll_id = source.payroll_id)
     WHEN NOT MATCHED THEN INSERT
       (payroll_id, run_id, employee_id, status, attempt_count)
       VALUES (source.payroll_id, source.run_id, source.employee_id, 'PENDING', 0)`,
    { runId }
  );
}

async function listForRun(conn, runId) {
  const result = await conn.execute(
    `SELECT d.document_id, d.payroll_id, d.employee_id, d.status,
            d.attempt_count, d.generated_at, d.error_message,
            p.employee_code, e.full_name
       FROM payslip_documents d
       JOIN payroll p ON p.payroll_id = d.payroll_id
       JOIN employees e ON e.employee_id = d.employee_id
      WHERE d.run_id = :runId
      ORDER BY p.employee_code`,
    { runId }
  );
  return result.rows;
}

async function getForPayroll(conn, payrollId, forUpdate = false) {
  const result = await conn.execute(
    `SELECT d.document_id, d.payroll_id, d.run_id, d.employee_id, d.status,
            d.content, d.sha256, d.file_size, d.attempt_count, d.generated_at,
            d.error_message, d.lease_until,
            CASE WHEN d.lease_until > LOCALTIMESTAMP THEN 1 ELSE 0 END AS lease_active,
            p.employee_code, p.pay_month, p.pay_year,
            r.status AS run_status, p.approval_status, e.full_name
       FROM payslip_documents d
       JOIN payroll p ON p.payroll_id = d.payroll_id
       JOIN payroll_runs r ON r.run_id = d.run_id
       JOIN employees e ON e.employee_id = d.employee_id
      WHERE d.payroll_id = :payrollId${forUpdate ? ' FOR UPDATE' : ''}`,
    { payrollId }
  );
  return result.rows[0] || null;
}

async function claim(conn, payrollId, leaseMinutes) {
  const current = await getForPayroll(conn, payrollId, true);
  if (!current) return { state: 'NOT_FOUND' };
  if (current.STATUS === 'GENERATED') return { state: 'GENERATED', document: current };
  if (current.LEASE_ACTIVE === 1) return { state: 'IN_PROGRESS', document: current };
  const token = require('crypto').randomBytes(24).toString('hex');
  const result = await conn.execute(
    `UPDATE payslip_documents
        SET status = 'PENDING', generation_token = :token,
            lease_until = LOCALTIMESTAMP + NUMTODSINTERVAL(:leaseMinutes, 'MINUTE'),
            attempt_count = attempt_count + 1, error_message = NULL,
            updated_at = SYSTIMESTAMP
      WHERE payroll_id = :payrollId
        AND status IN ('PENDING', 'FAILED')`,
    { payrollId, token, leaseMinutes }
  );
  if (!result.rowsAffected) return { state: 'IN_PROGRESS', document: current };
  await conn.commit();
  return { state: 'CLAIMED', token, document: await getForPayroll(conn, payrollId) };
}

async function markGenerated(conn, payrollId, token, buffer, sha256) {
  const result = await conn.execute(
    `UPDATE payslip_documents
        SET status = 'GENERATED', content = :content, sha256 = :sha256,
            file_size = :fileSize, generated_at = SYSTIMESTAMP,
            error_message = NULL, lease_until = NULL, generation_token = NULL,
            updated_at = SYSTIMESTAMP
      WHERE payroll_id = :payrollId AND status = 'PENDING' AND generation_token = :token`,
    {
      payrollId,
      token,
      content: { val: buffer, type: db.oracledb.BLOB },
      sha256,
      fileSize: buffer.length
    }
  );
  if (!result.rowsAffected) throw new Error('Payslip generation lease expired.');
  await conn.commit();
}

async function markFailed(conn, payrollId, token, message) {
  await conn.execute(
    `UPDATE payslip_documents
        SET status = 'FAILED', error_message = :message,
            lease_until = NULL, generation_token = NULL, updated_at = SYSTIMESTAMP
      WHERE payroll_id = :payrollId AND status = 'PENDING' AND generation_token = :token`,
    { payrollId, token, message: String(message || 'Payslip generation failed.').slice(0, 500) }
  );
  await conn.commit();
}

async function getRun(conn, runId) {
  const result = await conn.execute(
    `SELECT run_id, status FROM payroll_runs WHERE run_id = :runId`, { runId }
  );
  return result.rows[0] || null;
}

async function getGenerationData(conn, payrollId) {
  const result = await conn.execute(
    `SELECT p.*, e.employee_code AS emp_code, e.full_name, e.department,
            e.designation, e.bank_account, e.bank_name, e.ifsc_code, e.pan_no
       FROM payroll p JOIN employees e ON e.employee_id = p.employee_id
      WHERE p.payroll_id = :payrollId`,
    { payrollId }
  );
  return result.rows[0] || null;
}

module.exports = {
  ensurePendingForRun, listForRun, getForPayroll, getGenerationData,
  claim, markGenerated, markFailed, getRun
};
