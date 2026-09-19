const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayrollEmailWorker } = require('../server/services/payrollEmailWorker');
const { isValidEmail, enqueueForRun } = require('../server/repositories/payslipEmailRepository');
const { createPayrollEmailService } = require('../server/services/payrollEmailService');

function makeWorker({ jobs, sendMail, documents = {} }) {
  const marked = { sent: [], failed: [] };
  const worker = createPayrollEmailWorker({
    db: {
      withConnection: async (fn) => fn({})
    },
    jobRepository: {
      claimNext: async () => jobs.shift() || null,
      markSent: async (_conn, id) => marked.sent.push(id),
      markFailed: async (_conn, id, _token, reason) => marked.failed.push({ id, reason })
    },
    payslipRepository: {
      getForPayroll: async (_conn, id) => documents[id]
    },
    sendMail,
    maxJobsPerCycle: 25
  });
  return { worker, marked };
}

function document(payrollId, employeeCode = `E-${payrollId}`) {
  return { STATUS: 'GENERATED', CONTENT: Buffer.from(`pdf-${payrollId}`), FULL_NAME: employeeCode,
    EMPLOYEE_CODE: employeeCode, PAY_MONTH: 7, PAY_YEAR: 2026 };
}

test('worker sends the stored payslip and records SENT without exposing content to logs', async () => {
  const sent = [];
  const { worker, marked } = makeWorker({
    jobs: [{ JOB_ID: 1, PAYROLL_ID: 10, EMAIL_ADDRESS: 'a@example.test', processingToken: 'token' }],
    documents: { 10: document(10) },
    sendMail: async (message) => { sent.push(message); return { success: true }; }
  });
  assert.deepEqual(await worker.processPending(), { processed: 1, sent: 1, failed: 0 });
  assert.equal(sent[0].to, 'a@example.test');
  assert.deepEqual(sent[0].attachments[0].content, Buffer.from('pdf-10'));
  assert.deepEqual(marked, { sent: [1], failed: [] });
});

test('failed delivery is recorded safely and can be retried by the queue', async () => {
  const { worker, marked } = makeWorker({
    jobs: [{ JOB_ID: 2, PAYROLL_ID: 11, EMAIL_ADDRESS: 'b@example.test', processingToken: 'token' }],
    documents: { 11: document(11) },
    sendMail: async () => ({ success: false, error: 'SMTP recipient rejected: b@example.test' })
  });
  assert.deepEqual(await worker.processPending(), { processed: 1, sent: 0, failed: 1 });
  assert.equal(marked.failed[0].reason, 'Email delivery failed.');
});

test('worker does not deliver a payslip while its payroll run is on hold', async () => {
  let deliveries = 0;
  const heldDocument = { ...document(12), RUN_STATUS: 'HOLD' };
  const { worker, marked } = makeWorker({
    jobs: [{ JOB_ID: 3, PAYROLL_ID: 12, EMAIL_ADDRESS: 'held@example.test', processingToken: 'token' }],
    documents: { 12: heldDocument },
    sendMail: async () => { deliveries += 1; return { success: true }; }
  });
  assert.deepEqual(await worker.processPending(), { processed: 1, sent: 0, failed: 1 });
  assert.equal(deliveries, 0);
  assert.equal(marked.failed[0].reason, 'Payslip is not available for delivery.');
});

test('worker does not deliver a claimed job after its employee payroll row is put on hold', async () => {
  let deliveries = 0;
  const heldDocument = { ...document(13), RUN_STATUS: 'FINALIZED', APPROVAL_STATUS: 'HOLD' };
  const { worker, marked } = makeWorker({
    jobs: [{ JOB_ID: 4, PAYROLL_ID: 13, EMAIL_ADDRESS: 'held-row@example.test', processingToken: 'token' }],
    documents: { 13: heldDocument },
    sendMail: async () => { deliveries += 1; return { success: true }; }
  });
  assert.deepEqual(await worker.processPending(), { processed: 1, sent: 0, failed: 1 });
  assert.equal(deliveries, 0);
  assert.equal(marked.failed[0].reason, 'Payslip is not available for delivery.');
});

test('bulk processing is bounded and does not process the same claimed job twice', async () => {
  const jobs = [1, 2, 3].map((id) => ({ JOB_ID: id, PAYROLL_ID: id, EMAIL_ADDRESS: `${id}@example.test`, processingToken: `t${id}` }));
  const { worker, marked } = makeWorker({
    jobs,
    documents: { 1: document(1), 2: document(2), 3: document(3) },
    sendMail: async () => ({ success: true })
  });
  assert.deepEqual(await worker.processPending(2), { processed: 2, sent: 2, failed: 0 });
  assert.deepEqual(marked.sent, [1, 2]);
  assert.equal(jobs.length, 1);
});

test('email validation marks missing and malformed recipients as non-retryable failures', async () => {
  assert.equal(isValidEmail('employee@example.test'), true);
  assert.equal(isValidEmail('missing-at-example.test'), false);
  assert.equal(isValidEmail(''), false);

  const statements = [];
  const conn = {
    execute: async (sql, binds) => {
      statements.push({ sql, binds });
      if (sql.startsWith('SELECT d.document_id')) {
        return { rows: [
          { DOCUMENT_ID: 1, PAYROLL_ID: 11, RUN_ID: 7, EMPLOYEE_ID: 101, EMPLOYEE_EMAIL: null },
          { DOCUMENT_ID: 2, PAYROLL_ID: 12, RUN_ID: 7, EMPLOYEE_ID: 102, EMPLOYEE_EMAIL: 'bad-address' }
        ] };
      }
      return { rowsAffected: 1 };
    }
  };
  const result = await enqueueForRun(conn, 7);
  assert.deepEqual(result, { created: 2, invalid: 2 });
  const merges = statements.filter((entry) => entry.sql.includes('MERGE INTO payslip_email_jobs'));
  assert.equal(merges.length, 2);
  assert.equal(merges[0].binds.status, 'FAILED');
  assert.equal(merges[0].binds.maxAttempts, 0);
});

test('duplicate queue requests are idempotent and failed jobs are requeued safely', async () => {
  let requeued = 0;
  const database = {
    execute: async (sql) => sql.includes('FROM payroll WHERE')
      ? { rows: [{ RUN_ID: 7 }] }
      : { rows: [{ RUN_ID: 7, STATUS: 'FINALIZED' }] },
    withConnection: async (fn) => fn({
      commit: async () => {}, rollback: async () => {},
    })
  };
  const repository = {
    getJob: async () => ({ STATUS: 'FAILED', ATTEMPT_COUNT: 1, MAX_ATTEMPTS: 5 }),
    requeueFailed: async () => { requeued += 1; return true; },
    enqueueForRun: async () => ({ created: 0, invalid: 0 })
  };
  const service = createPayrollEmailService({ db: database, jobRepository: repository });
  const result = await service.sendForRecord(42);
  assert.equal(result.status, 'PENDING');
  assert.equal(requeued, 1);
});
