const crypto = require('crypto');

const SAFE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && SAFE_EMAIL.test(value.trim());
}

async function enqueueForRun(conn, runId, payrollId = null) {
  const result = await conn.execute(
    `SELECT d.document_id, d.payroll_id, d.run_id, d.employee_id,
            e.email AS employee_email
       FROM payslip_documents d
       JOIN employees e ON e.employee_id = d.employee_id
       JOIN payroll p ON p.payroll_id = d.payroll_id
      WHERE d.run_id = :runId AND d.status = 'GENERATED'
        AND p.approval_status <> 'HOLD'
        AND (:payrollId IS NULL OR d.payroll_id = :payrollId)`,
    { runId, payrollId }
  );
  let created = 0;
  let invalid = 0;
  for (const row of result.rows) {
    const email = row.EMPLOYEE_EMAIL ? String(row.EMPLOYEE_EMAIL).trim().toLowerCase() : null;
    const valid = isValidEmail(email);
    const status = valid ? 'PENDING' : 'FAILED';
    const reason = !email ? 'No email address on file.' : 'Email address is invalid.';
    const inserted = await conn.execute(
      `MERGE INTO payslip_email_jobs j
       USING (SELECT :documentId document_id FROM dual) source
          ON (j.document_id = source.document_id)
       WHEN NOT MATCHED THEN INSERT
         (document_id, payroll_id, run_id, employee_id, email_address,
          status, attempt_count, max_attempts, failure_reason, idempotency_key)
         VALUES (:documentId, :payrollId, :runId, :employeeId, :emailAddress,
                 :status, 0, :maxAttempts, :failureReason, :idempotencyKey)`,
      {
        documentId: row.DOCUMENT_ID,
        payrollId: row.PAYROLL_ID,
        runId: row.RUN_ID,
        employeeId: row.EMPLOYEE_ID,
        emailAddress: email,
        status,
        maxAttempts: valid ? 5 : 0,
        failureReason: valid ? null : reason,
        idempotencyKey: crypto.createHash('sha256').update(`payslip:${row.DOCUMENT_ID}`).digest('hex')
      }
    );
    if (inserted.rowsAffected) {
      created += 1;
      if (!valid) invalid += 1;
    }
  }
  return { created, invalid };
}

async function claimNext(conn, workerId, leaseMinutes) {
  const result = await conn.execute(
    `SELECT j.job_id, j.document_id, j.payroll_id, j.run_id, j.employee_id,
            j.email_address, j.attempt_count, j.status
       FROM payslip_email_jobs j
       JOIN payroll_runs r ON r.run_id = j.run_id
       JOIN payroll p ON p.payroll_id = j.payroll_id
      WHERE (j.status IN ('PENDING', 'FAILED') OR (j.status = 'PROCESSING' AND j.lease_until <= LOCALTIMESTAMP))
        AND r.status = 'FINALIZED'
        AND p.approval_status <> 'HOLD'
        AND (j.status = 'PENDING' OR j.attempt_count < j.max_attempts)
        AND (j.lease_until IS NULL OR j.lease_until <= LOCALTIMESTAMP)
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= LOCALTIMESTAMP)
      AND j.job_id = (SELECT job_id FROM (
        SELECT j.job_id FROM payslip_email_jobs j
         JOIN payroll_runs r ON r.run_id = j.run_id
         JOIN payroll p ON p.payroll_id = j.payroll_id
         WHERE (j.status IN ('PENDING', 'FAILED') OR (j.status = 'PROCESSING' AND j.lease_until <= LOCALTIMESTAMP))
           AND r.status = 'FINALIZED'
           AND p.approval_status <> 'HOLD'
           AND (j.status = 'PENDING' OR j.attempt_count < j.max_attempts)
           AND (j.lease_until IS NULL OR j.lease_until <= LOCALTIMESTAMP)
           AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= LOCALTIMESTAMP)
         ORDER BY j.job_id
      ) WHERE ROWNUM = 1)
      FOR UPDATE SKIP LOCKED`
  );
  if (!result.rows.length) return null;
  const job = result.rows[0];
  const token = crypto.randomBytes(24).toString('hex');
  await conn.execute(
    `UPDATE payslip_email_jobs
        SET status = 'PROCESSING', processing_token = :token,
            lease_until = LOCALTIMESTAMP + NUMTODSINTERVAL(:leaseMinutes, 'MINUTE'),
            attempt_count = attempt_count + 1, last_attempt_at = SYSTIMESTAMP,
            failure_reason = NULL, updated_at = SYSTIMESTAMP,
            worker_id = :workerId
      WHERE job_id = :jobId`,
    { token, leaseMinutes, workerId, jobId: job.JOB_ID }
  );
  await conn.commit();
  return { ...job, processingToken: token, attemptCount: Number(job.ATTEMPT_COUNT) + 1 };
}

async function markSent(conn, jobId, token) {
  const result = await conn.execute(
    `UPDATE payslip_email_jobs
        SET status = 'SENT', sent_at = SYSTIMESTAMP, lease_until = NULL,
            processing_token = NULL, failure_reason = NULL, updated_at = SYSTIMESTAMP
      WHERE job_id = :jobId AND status = 'PROCESSING' AND processing_token = :token`,
    { jobId, token }
  );
  if (!result.rowsAffected) throw new Error('Email delivery lease expired.');
  await conn.commit();
}

async function markFailed(conn, jobId, token, reason) {
  await conn.execute(
    `UPDATE payslip_email_jobs
        SET status = 'FAILED', failure_reason = :reason, lease_until = NULL,
            next_attempt_at = LOCALTIMESTAMP + NUMTODSINTERVAL(LEAST(POWER(2, attempt_count), 60), 'MINUTE'),
            processing_token = NULL, updated_at = SYSTIMESTAMP
      WHERE job_id = :jobId AND status = 'PROCESSING' AND processing_token = :token`,
    { jobId, token, reason: String(reason || 'Email delivery failed.').slice(0, 500) }
  );
  await conn.commit();
}

async function listForRun(conn, runId) {
  const result = await conn.execute(
    `SELECT j.job_id, j.payroll_id, j.employee_id, j.status,
            j.attempt_count, j.sent_at, j.last_attempt_at, j.failure_reason,
            p.employee_code, e.full_name
       FROM payslip_email_jobs j
       JOIN payroll p ON p.payroll_id = j.payroll_id
       JOIN employees e ON e.employee_id = j.employee_id
      WHERE j.run_id = :runId
      ORDER BY p.employee_code`,
    { runId }
  );
  return result.rows;
}

async function getJob(conn, payrollId) {
  const result = await conn.execute(
    `SELECT j.job_id, j.payroll_id, j.run_id, j.employee_id,
            j.email_address, j.status, j.attempt_count, j.max_attempts, j.sent_at,
            j.last_attempt_at, j.failure_reason,
            p.employee_code, e.full_name, r.status AS run_status
       FROM payslip_email_jobs j
       JOIN payroll p ON p.payroll_id = j.payroll_id
       JOIN employees e ON e.employee_id = j.employee_id
       JOIN payroll_runs r ON r.run_id = j.run_id
      WHERE j.payroll_id = :payrollId`,
    { payrollId }
  );
  return result.rows[0] || null;
}

async function requeueFailed(conn, payrollId) {
  const result = await conn.execute(
    `UPDATE payslip_email_jobs
        SET status = 'PENDING', next_attempt_at = SYSTIMESTAMP,
            lease_until = NULL, processing_token = NULL,
            failure_reason = NULL, updated_at = SYSTIMESTAMP
      WHERE payroll_id = :payrollId AND status = 'FAILED'
        AND attempt_count < max_attempts AND email_address IS NOT NULL`,
    { payrollId }
  );
  return result.rowsAffected > 0;
}

module.exports = { isValidEmail, enqueueForRun, claimNext, markSent, markFailed, listForRun, getJob, requeueFailed };
