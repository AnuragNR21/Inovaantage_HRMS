const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const payrollProcessingService = require('../server/services/payrollProcessingService');
const { createPayrollProcessingService } = require('../server/services/payrollProcessingService');
const payrollWorkflowService = require('../server/services/payrollWorkflowService');
const payrollRecordService = require('../server/services/payrollRecordService');
const payrollRepository = require('../server/repositories/payrollRepository');
const { PAYROLL_STATES } = require('../server/domain/payroll/payrollStates');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const sourceFile = `domain-test-${suffix}.xlsx`;
const employeeCodeA = `PD${String(Date.now()).slice(-8)}A`;
const employeeCodeB = `PD${String(Date.now()).slice(-8)}B`;
let employeeIdA;
let employeeIdB;
let validatedRunId;
let validatedPayrollId;

function row(employeeCode, overrides = {}) {
  return {
    employee_code: employeeCode,
    employee_name: '',
    working_days: 30,
    present_days: 30,
    absent_days: 0,
    paid_leave_days: 0,
    lop_days: 0,
    half_days: 0,
    late_marks: 0,
    ot_hours: 0,
    basic_salary: 50000,
    hra: 10000,
    da: 0,
    conveyance: 1000,
    medical_allowance: 1000,
    special_allowance: 2000,
    professional_development: 0,
    other_allowance: 0,
    food_allowance: 0,
    bonus: 0,
    other_earnings: 0,
    total_earnings: 0,
    employer_contribution: 0,
    lop_amount: 0,
    gross_salary: 0,
    provident_fund: 3000,
    esi: 0,
    professional_tax: 200,
    income_tax: 1000,
    other_deductions: 0,
    total_deductions: 0,
    net_salary: 0,
    remarks: null,
    ...overrides
  };
}

function input(payMonth, rows) {
  return {
    payMonth,
    payYear: 2095,
    sourceFile,
    rows,
    actorUserId: null,
    actorUsername: 'payroll-domain-test'
  };
}

test.before(async () => {
  await db.initPool();
  await db.withConnection(async (conn) => {
    const first = await conn.execute(
      `INSERT INTO employees (employee_code, full_name, status)
       VALUES (:code, 'Payroll Domain A', 'ACTIVE') RETURNING employee_id INTO :newId`,
      { code: employeeCodeA, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    const second = await conn.execute(
      `INSERT INTO employees (employee_code, full_name, status)
       VALUES (:code, 'Payroll Domain B', 'ACTIVE') RETURNING employee_id INTO :newId`,
      { code: employeeCodeB, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    employeeIdA = first.outBinds.newId[0];
    employeeIdB = second.outBinds.newId[0];
    await conn.commit();
  });
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    const runs = await conn.execute(`SELECT run_id FROM payroll_runs WHERE source_file = :sourceFile`, { sourceFile });
    for (const run of runs.rows) {
      await conn.execute(`DELETE FROM upload_batches WHERE run_id = :runId`, { runId: run.RUN_ID });
      await conn.execute(`DELETE FROM payroll_run_events WHERE run_id = :runId`, { runId: run.RUN_ID });
      await conn.execute(`DELETE FROM payroll WHERE run_id = :runId`, { runId: run.RUN_ID });
      await conn.execute(`DELETE FROM payroll_runs WHERE run_id = :runId`, { runId: run.RUN_ID });
    }
    await conn.execute(`DELETE FROM employees WHERE employee_id IN (:employeeIdA, :employeeIdB)`, { employeeIdA, employeeIdB });
    await conn.commit();
  });
  await db.closePool();
});

test('payroll creation validates, calculates, and persists one complete run', async () => {
  const result = await payrollProcessingService.process(input(1, [row(employeeCodeA)]));
  validatedRunId = result.runId;
  assert.equal(result.status, PAYROLL_STATES.VALIDATED);
  assert.equal(result.rows, 1);

  const persisted = await db.execute(
    `SELECT p.payroll_id, p.total_earnings, p.total_deductions, p.net_salary, r.status
       FROM payroll p JOIN payroll_runs r ON r.run_id = p.run_id
      WHERE p.run_id = :runId`,
    { runId: validatedRunId }
  );
  assert.equal(persisted.rows.length, 1);
  validatedPayrollId = persisted.rows[0].PAYROLL_ID;
  assert.equal(persisted.rows[0].STATUS, PAYROLL_STATES.VALIDATED);
  assert.equal(persisted.rows[0].TOTAL_EARNINGS, 64000);
  assert.equal(persisted.rows[0].TOTAL_DEDUCTIONS, 4200);
  assert.equal(persisted.rows[0].NET_SALARY, 59800);
});

test('duplicate employee payroll rows require an explicit replacement decision', async () => {
  await assert.rejects(
    payrollProcessingService.process(input(1, [row(employeeCodeA)])),
    (err) => err.statusCode === 422 && err.code === 'PAYROLL_DUPLICATE_RESOLUTION_REQUIRED'
  );
  const count = await db.execute(`SELECT COUNT(*) AS cnt FROM payroll WHERE run_id = :runId`, { runId: validatedRunId });
  assert.equal(count.rows[0].CNT, 1);
});

test('invalid payroll is rejected before a run or records are created', async () => {
  await assert.rejects(
    payrollProcessingService.process(input(2, [row(employeeCodeA, { basic_salary: -1 })])),
    (err) => err.statusCode === 422 && err.code === 'PAYROLL_INVALID'
  );
  const run = await db.execute(`SELECT run_id FROM payroll_runs WHERE pay_month = 2 AND pay_year = 2095`);
  assert.equal(run.rows.length, 0);
});

test('validated payroll can be approved and finalized in order', async () => {
  assert.equal((await payrollWorkflowService.approve(validatedRunId, null)).STATUS, PAYROLL_STATES.APPROVED);
  assert.equal((await payrollWorkflowService.finalize(validatedRunId, null)).STATUS, PAYROLL_STATES.FINALIZED);
  assert.equal((await payrollWorkflowService.hold(validatedRunId, null)).STATUS, PAYROLL_STATES.HOLD);
  assert.equal((await payrollWorkflowService.release(validatedRunId, null)).STATUS, PAYROLL_STATES.FINALIZED);
  const run = await db.execute(`SELECT status FROM payroll_runs WHERE run_id = :runId`, { runId: validatedRunId });
  assert.equal(run.rows[0].STATUS, PAYROLL_STATES.FINALIZED);
});

test('invalid state transitions and finalized record modification are blocked', async () => {
  const created = await payrollProcessingService.process(input(3, [row(employeeCodeA)]));
  await assert.rejects(
    payrollWorkflowService.finalize(created.runId, null),
    (err) => err.statusCode === 409 && err.code === 'INVALID_PAYROLL_STATE_TRANSITION'
  );
  await assert.rejects(
    payrollRecordService.deleteRecord(validatedPayrollId, null),
    (err) => err.statusCode === 409 && err.code === 'PAYROLL_RECORD_IMMUTABLE'
  );
  const editableRecord = await db.execute(
    `SELECT payroll_id FROM payroll WHERE run_id = :runId`,
    { runId: created.runId }
  );
  await payrollRecordService.deleteRecord(editableRecord.rows[0].PAYROLL_ID, null);
  const emptiedRun = await db.execute(
    `SELECT total_rows, validated_rows FROM payroll_runs WHERE run_id = :runId`,
    { runId: created.runId }
  );
  assert.equal(emptiedRun.rows[0].TOTAL_ROWS, 0);
  assert.equal(emptiedRun.rows[0].VALIDATED_ROWS, 0);
  await assert.rejects(
    payrollWorkflowService.approve(created.runId, null),
    (err) => err.statusCode === 409 && err.code === 'PAYROLL_NOT_READY'
  );
});

test('mid-batch persistence failure rolls back every payroll row and marks the run failed', async () => {
  let insertCount = 0;
  const failingRepository = {
    ...payrollRepository,
    async insertPayroll(conn, runData, payrollRow) {
      insertCount += 1;
      const result = await payrollRepository.insertPayroll(conn, runData, payrollRow);
      if (insertCount === 2) throw new Error('Injected persistence failure');
      return result;
    }
  };
  const service = createPayrollProcessingService({ payrollRepository: failingRepository });
  let failedRunId;
  await assert.rejects(
    service.process(input(4, [row(employeeCodeA), row(employeeCodeB)])),
    (err) => {
      failedRunId = err.runId;
      return err.message === 'Injected persistence failure';
    }
  );
  const run = await db.execute(`SELECT status FROM payroll_runs WHERE run_id = :runId`, { runId: failedRunId });
  const records = await db.execute(`SELECT COUNT(*) AS cnt FROM payroll WHERE run_id = :runId`, { runId: failedRunId });
  const failureEvent = await db.execute(
    `SELECT COUNT(*) AS cnt FROM payroll_run_events
      WHERE run_id = :runId AND event_type = 'PAYROLL_FAILED'`,
    { runId: failedRunId }
  );
  assert.equal(run.rows[0].STATUS, PAYROLL_STATES.FAILED);
  assert.equal(records.rows[0].CNT, 0);
  assert.equal(failureEvent.rows[0].CNT, 1);

  const recovered = await payrollProcessingService.process(input(4, [row(employeeCodeA), row(employeeCodeB)]));
  const recoveredRecords = await db.execute(
    `SELECT COUNT(*) AS cnt FROM payroll WHERE run_id = :runId`,
    { runId: failedRunId }
  );
  assert.equal(recovered.runId, failedRunId);
  assert.equal(recovered.status, PAYROLL_STATES.VALIDATED);
  assert.equal(recoveredRecords.rows[0].CNT, 2);
});
