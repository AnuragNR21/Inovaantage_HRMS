const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const payslipGenerationService = require('../server/services/payslipGenerationService');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const sourceFile = `payslip-generation-${suffix}.xlsx`;
const employeeCodeA = `PG${String(Date.now()).slice(-8)}A`;
const employeeCodeB = `PG${String(Date.now()).slice(-8)}B`;
let employeeIdA;
let employeeIdB;
let runId;
let payrollIdA;
let payrollIdB;

function payrollInsert(employeeId, employeeCode) {
  return db.withConnection(async (conn) => {
    const result = await conn.execute(
      `INSERT INTO payroll
        (run_id, employee_id, employee_code, pay_month, pay_year, basic_salary,
         total_earnings, total_deductions, net_salary, source_file)
       VALUES (:runId, :employeeId, :employeeCode, 9, 2094, 50000, 55000, 5000, 50000, :sourceFile)
       RETURNING payroll_id INTO :newId`,
      {
        runId, employeeId, employeeCode, sourceFile,
        newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
      }
    );
    await conn.commit();
    return result.outBinds.newId[0];
  });
}

function fakePdf(row) {
  return Promise.resolve(Buffer.from(`%PDF-fake-${row.EMP_CODE}`));
}

test.before(async () => {
  await db.initPool();
  await db.withConnection(async (conn) => {
    const first = await conn.execute(
      `INSERT INTO employees (employee_code, full_name, status)
       VALUES (:code, 'Payslip Generation A', 'ACTIVE') RETURNING employee_id INTO :newId`,
      { code: employeeCodeA, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    const second = await conn.execute(
      `INSERT INTO employees (employee_code, full_name, status)
       VALUES (:code, 'Payslip Generation B', 'ACTIVE') RETURNING employee_id INTO :newId`,
      { code: employeeCodeB, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    employeeIdA = first.outBinds.newId[0];
    employeeIdB = second.outBinds.newId[0];
    const run = await conn.execute(
      `INSERT INTO payroll_runs (pay_month, pay_year, status, source_file, total_rows, validated_rows)
       VALUES (9, 2094, 'FINALIZED', :sourceFile, 2, 2)
       RETURNING run_id INTO :newId`,
      { sourceFile, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    runId = run.outBinds.newId[0];
    await conn.commit();
  });
  payrollIdA = await payrollInsert(employeeIdA, employeeCodeA);
  payrollIdB = await payrollInsert(employeeIdB, employeeCodeB);
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    await conn.execute(`DELETE FROM payslip_documents WHERE run_id = :runId`, { runId });
    await conn.execute(`DELETE FROM payroll WHERE run_id = :runId`, { runId });
    await conn.execute(`DELETE FROM payroll_run_events WHERE run_id = :runId`, { runId });
    await conn.execute(`DELETE FROM payroll_runs WHERE run_id = :runId`, { runId });
    await conn.execute(`DELETE FROM employees WHERE employee_id IN (:employeeIdA, :employeeIdB)`, { employeeIdA, employeeIdB });
    await conn.commit();
  });
  await db.closePool();
});

test('generates one stored document per payroll record and is duplicate-safe', async () => {
  const service = payslipGenerationService.createPayslipGenerationService({ buildPdf: fakePdf });
  const first = await service.generateForRun(runId);
  assert.equal(first.total, 2);
  assert.equal(first.generated, 2);
  assert.equal(first.failed, 0);
  assert.equal(new Set(first.results.map((item) => item.payrollId)).size, 2);

  const rows = await db.execute(
    `SELECT payroll_id, status, file_size, sha256, attempt_count FROM payslip_documents WHERE run_id = :runId`,
    { runId }
  );
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows.every((row) => row.STATUS === 'GENERATED' && row.FILE_SIZE > 0 && row.SHA256));
  assert.ok(rows.rows.every((row) => row.ATTEMPT_COUNT === 1));

  const repeated = await service.generateForRun(runId);
  assert.equal(repeated.generated, 2);
  const attempts = await db.execute(`SELECT MAX(attempt_count) AS max_attempt FROM payslip_documents WHERE run_id = :runId`, { runId });
  assert.equal(attempts.rows[0].MAX_ATTEMPT, 1);
});

test('one generation failure is isolated, visible, and safely retryable', async () => {
  await db.execute(
    `UPDATE payslip_documents
        SET status = 'PENDING', content = NULL, attempt_count = 0,
            error_message = NULL, generated_at = NULL, lease_until = NULL,
            generation_token = NULL
      WHERE run_id = :runId`,
    { runId }, {}, true
  );
  let fail = true;
  const service = payslipGenerationService.createPayslipGenerationService({
    buildPdf: async (row) => {
      if (fail && row.EMP_CODE === employeeCodeB) throw new Error('injected PDF failure');
      return fakePdf(row);
    }
  });
  const first = await service.generateForRun(runId);
  assert.equal(first.generated, 1);
  assert.equal(first.failed, 1);
  const failed = await db.execute(`SELECT status, attempt_count FROM payslip_documents WHERE payroll_id = :payrollId`, { payrollId: payrollIdB });
  assert.equal(failed.rows[0].STATUS, 'FAILED');
  assert.equal(failed.rows[0].ATTEMPT_COUNT, 1);
  const payroll = await db.execute(`SELECT status FROM payroll_runs WHERE run_id = :runId`, { runId });
  assert.equal(payroll.rows[0].STATUS, 'FINALIZED');

  fail = false;
  const retry = await service.generateForRun(runId);
  assert.equal(retry.generated, 2);
  const recovered = await db.execute(`SELECT status, attempt_count FROM payslip_documents WHERE payroll_id = :payrollId`, { payrollId: payrollIdB });
  assert.equal(recovered.rows[0].STATUS, 'GENERATED');
  assert.equal(recovered.rows[0].ATTEMPT_COUNT, 2);
});

test('generated download returns PDF bytes without internal storage metadata', async () => {
  const service = payslipGenerationService.createPayslipGenerationService({ buildPdf: fakePdf });
  const result = await service.getDownload({ dataScope: { type: 'ALL' } }, payrollIdA);
  assert.equal(result.content.subarray(0, 4).toString(), '%PDF');
  assert.match(result.fileName, new RegExp(employeeCodeA));
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sha256'), false);
});
