const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const db = require('../server/db');
const { routeApi } = require('../server/router');
const { ROLES } = require('../server/authorization/permissions');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const codePrefix = String(Date.now()).slice(-8);
const actors = {};
const payrollIds = {};

class TestResponse extends PassThrough {
  constructor() {
    super();
    this.statusCode = null;
    this.headersSent = false;
    this.headers = new Map();
    this.chunks = [];
    this.on('data', (chunk) => this.chunks.push(Buffer.from(chunk)));
  }

  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  writeHead(statusCode, values) {
    this.statusCode = statusCode;
    this.headersSent = true;
    Object.entries(values || {}).forEach(([name, value]) => this.setHeader(name, value));
    return this;
  }
}

function request(actor, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  req.session = {
    userId: actor.userId,
    username: actor.username,
    employeeId: actor.employeeId,
    mustChangePassword: false
  };
  return req;
}

async function call(actor, method, url, body) {
  const res = new TestResponse();
  const finished = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  await routeApi(request(actor, method, url, body), res);
  const contentType = String(res.getHeader('content-type') || '');
  if (contentType.includes('application/pdf') && !res.writableFinished) {
    await finished;
  }
  const responseBody = Buffer.concat(res.chunks);
  let payload = null;
  if (contentType.includes('application/json') && responseBody.length) {
    payload = JSON.parse(responseBody.toString('utf8'));
  }
  return { status: res.statusCode, contentType, payload, body: responseBody };
}

async function insertEmployee(conn, label) {
  const employeeCode = `DI${codePrefix}${label}`;
  const result = await conn.execute(
    `INSERT INTO employees (employee_code, full_name, department, designation, email, status)
     VALUES (:employeeCode, :fullName, 'Security', 'Isolation Test', :email, 'ACTIVE')
     RETURNING employee_id INTO :newId`,
    {
      employeeCode,
      fullName: `Data Isolation ${label}`,
      email: `data-isolation-${label.toLowerCase()}-${suffix}@example.test`,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }
  );
  return { employeeId: result.outBinds.newId[0], employeeCode };
}

async function insertActor(conn, label, employeeId, roles) {
  const username = `isolation_${label.toLowerCase()}_${suffix}`;
  const result = await conn.execute(
    `INSERT INTO app_users
      (username, password_hash, full_name, employee_id, role, is_active, must_change_password, password_version)
     VALUES (:username, 'not-used-by-isolation-tests', :fullName, :employeeId, 'VIEWER', 1, 0, 1)
     RETURNING user_id INTO :newId`,
    {
      username,
      fullName: `Isolation Actor ${label}`,
      employeeId,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }
  );
  const actor = { userId: result.outBinds.newId[0], username, employeeId };
  for (const role of roles) {
    await conn.execute(
      `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
       SELECT :userId, role_id, NULL FROM auth_roles WHERE role_code = :role`,
      { userId: actor.userId, role }
    );
  }
  return actor;
}

async function insertPayroll(conn, employee, payMonth) {
  const runResult = await conn.execute(
    `INSERT INTO payroll_runs
      (pay_month, pay_year, status, source_file, total_rows, validated_rows)
     VALUES (:payMonth, 2098, 'FINALIZED', 'security-test.xlsx', 1, 1)
     RETURNING run_id INTO :newId`,
    {
      payMonth,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }
  );
  const runId = runResult.outBinds.newId[0];
  const result = await conn.execute(
    `INSERT INTO payroll
      (run_id, employee_id, employee_code, pay_month, pay_year, basic_salary,
       total_earnings, total_deductions, net_salary, source_file)
     VALUES (:runId, :employeeId, :employeeCode, :payMonth, 2098, 50000, 55000, 5000, 50000, 'security-test.xlsx')
     RETURNING payroll_id INTO :newId`,
    {
      runId,
      employeeId: employee.employeeId,
      employeeCode: employee.employeeCode,
      payMonth,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }
  );
  return { payrollId: result.outBinds.newId[0], runId };
}

test.before(async () => {
  await db.initPool();
  await db.withConnection(async (conn) => {
    const employeeA = await insertEmployee(conn, 'A');
    const employeeB = await insertEmployee(conn, 'B');
    actors.employeeA = await insertActor(conn, 'EmployeeA', employeeA.employeeId, [ROLES.EMPLOYEE]);
    actors.employeeB = await insertActor(conn, 'EmployeeB', employeeB.employeeId, [ROLES.EMPLOYEE]);
    actors.unlinked = await insertActor(conn, 'Unlinked', null, [ROLES.EMPLOYEE]);
    actors.privileged = await insertActor(conn, 'Privileged', null, [ROLES.HR_ADMIN, ROLES.PAYROLL_OPERATOR]);
    actors.employeeA.employeeCode = employeeA.employeeCode;
    actors.employeeB.employeeCode = employeeB.employeeCode;
    const payrollA = await insertPayroll(conn, employeeA, 1);
    const payrollB = await insertPayroll(conn, employeeB, 2);
    payrollIds.employeeA = payrollA.payrollId;
    payrollIds.employeeB = payrollB.payrollId;
    payrollIds.runA = payrollA.runId;
    payrollIds.runB = payrollB.runId;
    await conn.commit();
  });
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    await conn.execute(`DELETE FROM payslip_documents WHERE payroll_id IN (:payrollA, :payrollB)`, {
      payrollA: payrollIds.employeeA,
      payrollB: payrollIds.employeeB
    });
    await conn.execute(`DELETE FROM payroll WHERE payroll_id IN (:payrollA, :payrollB)`, {
      payrollA: payrollIds.employeeA,
      payrollB: payrollIds.employeeB
    });
    await conn.execute(`DELETE FROM payroll_run_events WHERE run_id IN (:runA, :runB)`, {
      runA: payrollIds.runA,
      runB: payrollIds.runB
    });
    await conn.execute(`DELETE FROM payroll_runs WHERE run_id IN (:runA, :runB)`, {
      runA: payrollIds.runA,
      runB: payrollIds.runB
    });
    for (const actor of Object.values(actors)) {
      await conn.execute(`DELETE FROM auth_user_roles WHERE user_id = :userId`, { userId: actor.userId });
      await conn.execute(`DELETE FROM app_users WHERE user_id = :userId`, { userId: actor.userId });
    }
    await conn.execute(`DELETE FROM employees WHERE employee_id IN (:employeeA, :employeeB)`, {
      employeeA: actors.employeeA.employeeId,
      employeeB: actors.employeeB.employeeId
    });
    await conn.commit();
  });
  await db.closePool();
});

test('employee profile access is restricted by the linked employee id', async () => {
  const own = await call(actors.employeeA, 'GET', `/api/employees/${actors.employeeA.employeeId}`);
  assert.equal(own.status, 200);
  assert.equal(own.payload.employee.EMPLOYEE_ID, actors.employeeA.employeeId);

  const changedId = await call(actors.employeeA, 'GET', `/api/employees/${actors.employeeB.employeeId}`);
  assert.equal(changedId.status, 404);
  assert.equal(changedId.payload.message, 'Employee not found.');
});

test('employee cannot enumerate the employee directory', async () => {
  const result = await call(actors.employeeA, 'GET', '/api/employees');
  assert.equal(result.status, 403);
});

test('payroll history is scoped in SQL and ignores hostile employee query parameters', async () => {
  const own = await call(actors.employeeA, 'GET', `/api/payroll?employeeId=${actors.employeeB.employeeId}`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.payload.records.map((row) => row.PAYROLL_ID), [payrollIds.employeeA]);

  const searchedOther = await call(actors.employeeA, 'GET', `/api/payroll?search=${actors.employeeB.employeeCode}`);
  assert.equal(searchedOther.status, 200);
  assert.deepEqual(searchedOther.payload.records, []);
});

test('payslip download rejects a changed payroll id without revealing ownership', async () => {
  const own = await call(actors.employeeA, 'GET', `/api/payroll/${payrollIds.employeeA}/payslip`);
  assert.equal(own.status, 200);
  assert.match(own.contentType, /application\/pdf/);
  assert.equal(own.body.subarray(0, 4).toString(), '%PDF');

  const changedId = await call(actors.employeeA, 'GET', `/api/payroll/${payrollIds.employeeB}/payslip`);
  assert.equal(changedId.status, 404);
  assert.equal(changedId.payload.message, 'Payroll record not found.');
});

test('employee cannot create, update, delete, upload, or email payroll data', async () => {
  const attempts = [
    ['POST', '/api/employees', { employeeId: actors.employeeB.employeeId }],
    ['PUT', `/api/employees/${actors.employeeA.employeeId}`, { employeeId: actors.employeeB.employeeId }],
    ['PUT', `/api/employees/${actors.employeeB.employeeId}`, {}],
    ['PATCH', `/api/employees/${actors.employeeB.employeeId}`, { employeeId: actors.employeeB.employeeId }],
    ['DELETE', `/api/employees/${actors.employeeA.employeeId}`],
    ['DELETE', `/api/employees/${actors.employeeB.employeeId}?cascade=true`],
    ['PUT', `/api/payroll/${payrollIds.employeeA}`, { employeeId: actors.employeeB.employeeId }],
    ['PATCH', `/api/payroll/${payrollIds.employeeB}`, { employeeId: actors.employeeB.employeeId }],
    ['DELETE', `/api/payroll/${payrollIds.employeeA}`],
    ['DELETE', `/api/payroll/${payrollIds.employeeB}`],
    ['POST', '/api/salary/upload'],
    ['POST', `/api/payroll/${payrollIds.employeeA}/send-slip`],
    ['POST', '/api/payroll/send-slips', { employeeId: actors.employeeB.employeeId }]
  ];
  for (const [method, url, body] of attempts) {
    const result = await call(actors.employeeA, method, url, body);
    assert.equal(result.status, 403, `${method} ${url} must be forbidden`);
  }
});

test('an unlinked employee account is denied self-scoped data', async () => {
  const result = await call(actors.unlinked, 'GET', `/api/employees/${actors.employeeA.employeeId}`);
  assert.equal(result.status, 403);
  assert.equal(result.payload.code, 'EMPLOYEE_LINK_REQUIRED');
});

test('explicit broad permissions retain cross-employee operational access', async () => {
  const employees = await call(actors.privileged, 'GET', '/api/employees');
  assert.equal(employees.status, 200);
  assert.equal(employees.payload.employees.some((row) => row.EMPLOYEE_ID === actors.employeeA.employeeId), true);
  assert.equal(employees.payload.employees.some((row) => row.EMPLOYEE_ID === actors.employeeB.employeeId), true);

  const payroll = await call(actors.privileged, 'GET', '/api/payroll?year=2098');
  assert.equal(payroll.status, 200);
  const returnedIds = new Set(payroll.payload.records.map((row) => row.PAYROLL_ID));
  assert.equal(returnedIds.has(payrollIds.employeeA), true);
  assert.equal(returnedIds.has(payrollIds.employeeB), true);
});
