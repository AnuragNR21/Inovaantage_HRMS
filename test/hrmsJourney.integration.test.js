const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const XLSX = require('xlsx');
const db = require('../server/db');
const authService = require('../server/services/authService');
const userService = require('../server/services/userService');
const payrollImportService = require('../server/services/payrollImportService');
const payrollEmailService = require('../server/services/payrollEmailService');
const { createPayrollEmailWorker } = require('../server/services/payrollEmailWorker');
const emailJobs = require('../server/repositories/payslipEmailRepository');
const sessionStore = require('../server/utils/sessionStore');
const { hashPassword } = require('../server/services/passwordService');
const { routeApi } = require('../server/router');
const { ROLES } = require('../server/authorization/permissions');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const sourceFile = `journey-${suffix}.xlsx`;
const payMonth = 11;
const payYear = 2096;
const codeSuffix = suffix.replace(/\D/g, '').slice(-10);
const employeeCodes = [`J-A-${codeSuffix}`, `J-B-${codeSuffix}`, `J-C-${codeSuffix}`];
const users = {};
const employees = {};
let runId;

class TestResponse extends PassThrough {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = new Map();
    this.chunks = [];
    this.on('data', (chunk) => this.chunks.push(Buffer.from(chunk)));
  }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  writeHead(statusCode, values) {
    this.statusCode = statusCode;
    Object.entries(values || {}).forEach(([name, value]) => this.setHeader(name, value));
    return this;
  }
}

function request(session, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.55' };
  req.session = session;
  return req;
}

async function call(session, method, url, body) {
  const res = new TestResponse();
  await routeApi(request(session, method, url, body), res);
  const contentType = String(res.getHeader('content-type') || '');
  const raw = Buffer.concat(res.chunks);
  let payload = null;
  if (contentType.includes('application/json') && raw.length) payload = JSON.parse(raw.toString('utf8'));
  return { status: res.statusCode, contentType, payload, body: raw };
}

function workbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Employee Code', 'Employee Name', 'Basic Salary', 'PF', 'Net Salary'],
    ...rows
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Salary');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function file(buffer) {
  return {
    buffer,
    originalFilename: sourceFile,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length
  };
}

async function insertEmployee(conn, code, name, email) {
  const result = await conn.execute(
    `INSERT INTO employees (employee_code, full_name, email, status)
     VALUES (:code, :name, :email, 'ACTIVE')
     RETURNING employee_id INTO :newId`,
    { code, name, email, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
  );
  return result.outBinds.newId[0];
}

async function createSystemAdmin() {
  const password = 'SystemAdmin@12345';
  const passwordHash = await hashPassword(password, { username: `e2e_admin_${suffix}` });
  const result = await db.execute(
    `INSERT INTO app_users (username, password_hash, full_name, role, is_active, must_change_password, password_version)
     VALUES (:username, :passwordHash, 'E2E System Admin', 'VIEWER', 1, 0, 1)
     RETURNING user_id INTO :newId`,
    { username: `e2e_admin_${suffix}`, passwordHash, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }, {}, true
  );
  const userId = result.outBinds.newId[0];
  await db.execute(
    `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
     SELECT :userId, role_id, :userId FROM auth_roles WHERE role_code = :role`,
    { userId, role: ROLES.SYSTEM_ADMIN }, {}, true
  );
  return { userId, username: `e2e_admin_${suffix}`, password };
}

async function login(username, password) {
  const result = await authService.login({ username, password, ipAddress: '127.0.0.55', userAgent: 'journey-test' });
  return { token: result.token, user: result.user, session: await sessionStore.getSession(result.token) };
}

test.before(async () => {
  await db.initPool();
  await db.withConnection(async (conn) => {
    employees.a = await insertEmployee(conn, employeeCodes[0], `E2E Employee A ${suffix}`, `e2e-a-${suffix}@example.test`);
    employees.b = await insertEmployee(conn, employeeCodes[1], `E2E Employee B ${suffix}`, `e2e-b-${suffix}@example.test`);
    employees.c = await insertEmployee(conn, employeeCodes[2], `E2E Employee C ${suffix}`, null);
    await conn.commit();
  });
  users.admin = await createSystemAdmin();
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    if (runId) {
      await conn.execute('UPDATE payroll_imports SET run_id = NULL WHERE run_id = :runId', { runId });
      await conn.execute('UPDATE payroll_runs SET import_id = NULL WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM payslip_email_jobs WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM payslip_documents WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM upload_batches WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM payroll_run_events WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM payroll WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM payroll_runs WHERE run_id = :runId', { runId });
      await conn.execute('DELETE FROM payroll_imports WHERE source_file = :sourceFile', { sourceFile });
    }
    const userIds = Object.values(users).map((user) => user.userId).filter(Boolean);
    if (userIds.length) {
      for (const userId of userIds) {
        await conn.execute('DELETE FROM payroll_imports WHERE created_by = :userId', { userId });
        await conn.execute('DELETE FROM auth_user_roles WHERE user_id = :userId OR assigned_by = :userId', { userId });
        await conn.execute('DELETE FROM user_sessions WHERE user_id = :userId', { userId });
        await conn.execute('DELETE FROM app_users WHERE user_id = :userId', { userId });
      }
    }
    await conn.execute('DELETE FROM employees WHERE employee_id IN (:a, :b, :c)', { a: employees.a, b: employees.b, c: employees.c });
    await conn.commit();
  });
  await db.closePool();
});

test('complete secured HRMS payroll journey succeeds and failure paths recover', async () => {
  await assert.rejects(
    authService.login({ username: users.admin.username, password: 'Wrong@12345', ipAddress: '127.0.0.55' }),
    (err) => err.code === 'AUTH_INVALID_CREDENTIALS'
  );

  const adminLogin = await login(users.admin.username, users.admin.password);
  const admin = adminLogin.session;

  const createdPayrollUser = await call(admin, 'POST', '/api/users', {
    username: `e2e_payroll_${suffix}`, password: 'PayrollUser@12345', fullName: 'E2E Payroll Executive',
    roles: [ROLES.PAYROLL_OPERATOR], mustChangePassword: false
  });
  assert.equal(createdPayrollUser.status, 201);
  users.payroll = { userId: createdPayrollUser.payload.userId, username: `e2e_payroll_${suffix}`, password: 'PayrollUser@12345' };

  const createdApprover = await call(admin, 'POST', '/api/users', {
    username: `e2e_approver_${suffix}`, password: 'ApproverUser@12345', fullName: 'E2E Payroll Approver',
    roles: [ROLES.PAYROLL_APPROVER], mustChangePassword: false
  });
  assert.equal(createdApprover.status, 201);
  users.approver = { userId: createdApprover.payload.userId, username: `e2e_approver_${suffix}`, password: 'ApproverUser@12345' };

  const createdEmployee = await call(admin, 'POST', '/api/users', {
    username: `e2e_employee_${suffix}`, password: 'EmployeeUser@12345', fullName: 'E2E Employee A',
    employeeId: employees.a, roles: [ROLES.EMPLOYEE], mustChangePassword: false
  });
  assert.equal(createdEmployee.status, 201);
  users.employee = { userId: createdEmployee.payload.userId, username: `e2e_employee_${suffix}`, password: 'EmployeeUser@12345' };

  const payrollLogin = await login(users.payroll.username, users.payroll.password);
  const payrollSession = payrollLogin.session;
  assert.ok(payrollLogin.user || payrollLogin.session);
  assert.equal((await call(payrollSession, 'GET', '/api/system/configuration')).status, 403);

  const invalidWorkbook = Buffer.from('not-an-excel-file');
  await assert.rejects(
    payrollImportService.preview({
      payMonth, payYear: payYear + 1, actorUserId: users.payroll.userId, actorUsername: users.payroll.username,
      requireAllEmployees: false,
      file: { buffer: invalidWorkbook, originalFilename: `${sourceFile}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: invalidWorkbook.length }
    }),
    (err) => err.code === 'PAYROLL_FILE_SIGNATURE_INVALID' || err.code === 'PAYROLL_FILE_CONTAINER_INVALID'
  );
  const preview = await payrollImportService.preview({
    payMonth, payYear, actorUserId: users.payroll.userId, actorUsername: users.payroll.username,
    requireAllEmployees: false,
    file: file(workbookBuffer([
      [employeeCodes[0], `E2E Employee A ${suffix}`, 50000, 5000, 45000],
      [employeeCodes[1], `E2E Employee B ${suffix}`, 60000, 6000, 54000],
      [employeeCodes[2], `E2E Employee C ${suffix}`, 70000, 7000, 63000]
    ]))
  });
  assert.equal(preview.readyForImport, true);
  assert.equal(preview.summary.validRows, 3);
  assert.ok(preview.previewToken);

  const imported = await payrollImportService.confirm(preview.previewToken, { userId: users.payroll.userId, username: users.payroll.username });
  assert.equal(imported.status, 'VALIDATED');
  runId = imported.runId;
  const duplicate = await payrollImportService.preview({
      payMonth, payYear, actorUserId: users.payroll.userId, actorUsername: users.payroll.username,
      requireAllEmployees: false, file: file(workbookBuffer([[employeeCodes[0], 'Duplicate period', 1, 0, 1]]))
    });
  assert.equal(duplicate.readyForImport, true);
  assert.equal(duplicate.requiresResolution, true);
  assert.equal(duplicate.summary.existingEmployeeConflicts, 1);

  const approverLogin = await login(users.approver.username, users.approver.password);
  const approverSession = approverLogin.session;
  assert.equal((await call(approverSession, 'POST', `/api/payroll/runs/${runId}/approve`)).status, 200);
  const finalized = await call(approverSession, 'POST', `/api/payroll/runs/${runId}/finalize`);
  assert.equal(finalized.status, 200);
  assert.equal(finalized.payload.status, 'FINALIZED');
  assert.equal(finalized.payload.generation.generated, 3);

  const queued = await call(payrollSession, 'POST', '/api/payroll/send-slips', { payMonth, payYear });
  assert.equal(queued.status, 200);
  assert.equal(queued.payload.queued, 2);
  assert.equal(queued.payload.invalid, 1);

  const jobs = await db.execute('SELECT payroll_id, status, max_attempts FROM payslip_email_jobs WHERE run_id = :runId ORDER BY payroll_id', { runId });
  assert.equal(jobs.rows.length, 3);
  assert.equal(jobs.rows.filter((row) => row.STATUS === 'FAILED').length, 1);

  const employeeLogin = await login(users.employee.username, users.employee.password);
  const employeeSession = employeeLogin.session;
  const ownEmployee = await call(employeeSession, 'GET', `/api/employees/${employees.a}`);
  const otherEmployee = await call(employeeSession, 'GET', `/api/employees/${employees.b}`);
  assert.equal(ownEmployee.status, 200);
  assert.equal(otherEmployee.status, 404);
  const ownPayroll = await call(employeeSession, 'GET', `/api/payroll?year=${payYear}`);
  assert.equal(ownPayroll.status, 200);
  assert.equal(ownPayroll.payload.records.length, 1);
  const otherPayslip = await call(employeeSession, 'GET', `/api/payroll/${jobs.rows[1].PAYROLL_ID}/payslip`);
  assert.equal(otherPayslip.status, 404);

  const delivered = [];
  const worker = createPayrollEmailWorker({
    sendMail: async (message) => { delivered.push(message.to); return { success: true }; },
    workerId: `journey-${suffix}`
  });
  const pendingJobs = jobs.rows.filter((job) => job.STATUS === 'PENDING');
  const firstJob = await db.withConnection((conn) => emailJobs.claimNext(conn, `journey-${suffix}`, 1));
  assert.ok(firstJob);
  await worker.processOne(firstJob);
  assert.deepEqual(delivered, [`e2e-a-${suffix}@example.test`]);

  const failedPayrollId = pendingJobs[1].PAYROLL_ID;
  const firstRetry = await payrollEmailService.sendForRecord(failedPayrollId);
  assert.equal(firstRetry.status, 'PENDING');
  const failureJob = await db.withConnection((conn) => emailJobs.claimNext(conn, `journey-failure-${suffix}`, 1));
  const failingWorker = createPayrollEmailWorker({ sendMail: async () => ({ success: false, error: 'SMTP failure for test' }) });
  await failingWorker.processOne(failureJob);
  const secondRetry = await payrollEmailService.sendForRecord(failedPayrollId);
  assert.equal(secondRetry.status, 'PENDING');
  const retryJob = await db.withConnection((conn) => emailJobs.claimNext(conn, `journey-retry-${suffix}`, 1));
  const recoveryWorker = createPayrollEmailWorker({ sendMail: async () => ({ success: true }) });
  await recoveryWorker.processOne(retryJob);
  const duplicateRetry = await payrollEmailService.sendForRecord(failedPayrollId);
  assert.equal(duplicateRetry.status, 'SENT');

  const audit = await call(admin, 'GET', '/api/audit?limit=20');
  assert.equal(audit.status, 200);
  assert.ok(audit.payload.records.some((event) => event.action === 'PAYSLIP_EMAIL'));
  assert.equal((await call(employeeSession, 'GET', '/api/audit')).status, 403);
  assert.equal((await call(approverSession, 'POST', `/api/payroll/runs/${runId}/approve`)).status, 409);
});
