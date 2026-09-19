const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const db = require('../server/db');
const authorizationService = require('../server/services/authorizationService');
const { routeApi } = require('../server/router');
const { PERMISSIONS: P, ROLES } = require('../server/authorization/permissions');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const users = new Map();

const expectedPermissions = {
  [ROLES.SYSTEM_ADMIN]: [
    P.AUDIT_VIEW, P.DASHBOARD_VIEW, P.ROLE_ASSIGN, P.ROLE_VIEW, P.SYSTEM_CONFIGURE,
    P.USER_CREATE, P.USER_DEACTIVATE, P.USER_UPDATE, P.USER_VIEW
  ],
  [ROLES.HR_ADMIN]: [
    P.DASHBOARD_VIEW, P.EMPLOYEE_CREATE, P.EMPLOYEE_DELETE, P.EMPLOYEE_UPDATE, P.EMPLOYEE_VIEW
  ],
  [ROLES.PAYROLL_OPERATOR]: [
    P.DASHBOARD_VIEW, P.EMPLOYEE_VIEW, P.PAYROLL_DELETE, P.PAYROLL_PROCESS,
    P.PAYROLL_UPLOAD, P.PAYROLL_VIEW, P.PAYSLIP_DOWNLOAD, P.PAYSLIP_EMAIL,
    P.PAYSLIP_GENERATE, P.PAYSLIP_VIEW, P.SALARY_UPDATE, P.SALARY_VIEW
  ],
  [ROLES.PAYROLL_APPROVER]: [
    P.DASHBOARD_VIEW, P.EMPLOYEE_VIEW, P.PAYROLL_APPROVE, P.PAYROLL_FINALIZE,
    P.PAYROLL_REVERSE, P.PAYROLL_VIEW, P.PAYSLIP_DOWNLOAD, P.PAYSLIP_EMAIL,
    P.PAYSLIP_VIEW, P.SALARY_VIEW
  ],
  [ROLES.MANAGER]: [],
  [ROLES.EMPLOYEE]: [
    P.EMPLOYEE_SELF_VIEW, P.PAYROLL_SELF_VIEW, P.PAYSLIP_SELF_DOWNLOAD,
    P.PAYSLIP_SELF_VIEW, P.SALARY_SELF_VIEW
  ],
  [ROLES.AUDITOR]: [
    P.AUDIT_VIEW, P.DASHBOARD_VIEW, P.PAYROLL_VIEW, P.PAYSLIP_DOWNLOAD,
    P.PAYSLIP_VIEW, P.SALARY_VIEW
  ]
};

function response() {
  const headers = new Map();
  return {
    statusCode: null,
    body: '',
    headersSent: false,
    getHeader: (name) => headers.get(name),
    setHeader: (name, value) => headers.set(name, value),
    writeHead(statusCode, values) {
      this.statusCode = statusCode;
      this.headersSent = true;
      Object.entries(values || {}).forEach(([name, value]) => headers.set(name, value));
    },
    end(body) { this.body = body || ''; this.headersSent = true; }
  };
}

function request(role, method, url, body) {
  const source = body === undefined ? [] : [JSON.stringify(body)];
  const req = Readable.from(source);
  req.method = method;
  req.url = url;
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  req.session = {
    userId: users.get(role),
    username: `rbac_${role.toLowerCase()}_${suffix}`,
    mustChangePassword: false
  };
  return req;
}

async function call(role, method, url, body) {
  const res = response();
  await routeApi(request(role, method, url, body), res);
  let payload = null;
  try { payload = JSON.parse(res.body); } catch (err) { /* response may be empty */ }
  return { status: res.statusCode, payload };
}

test.before(async () => {
  await db.initPool();
  await db.withConnection(async (conn) => {
    for (const role of Object.values(ROLES)) {
      const username = `rbac_${role.toLowerCase()}_${suffix}`;
      const inserted = await conn.execute(
        `INSERT INTO app_users
          (username, password_hash, full_name, role, is_active, must_change_password, password_version)
         VALUES (:username, 'not-used-by-rbac-tests', :fullName, 'VIEWER', 1, 0, 1)
         RETURNING user_id INTO :newId`,
        {
          username,
          fullName: `RBAC ${role}`,
          newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
        }
      );
      const userId = inserted.outBinds.newId[0];
      users.set(role, userId);
      await conn.execute(
        `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
         SELECT :userId, role_id, NULL FROM auth_roles WHERE role_code = :role`,
        { userId, role }
      );
    }
    await conn.commit();
  });
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    for (const userId of users.values()) {
      await conn.execute(`DELETE FROM auth_user_roles WHERE user_id = :userId`, { userId });
      await conn.execute(`DELETE FROM app_users WHERE user_id = :userId`, { userId });
    }
    await conn.commit();
  });
  await db.closePool();
});

for (const [role, permissions] of Object.entries(expectedPermissions)) {
  test(`${role} receives only its defined permissions`, async () => {
    const profile = await authorizationService.getAccessProfile(users.get(role));
    assert.deepEqual(profile.roles, [role]);
    assert.deepEqual(profile.permissions, [...permissions].sort());
  });
}

test('multiple roles produce a permission union', async () => {
  const userId = users.get(ROLES.MANAGER);
  await db.execute(
    `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
     SELECT :userId, role_id, NULL FROM auth_roles WHERE role_code = :role`,
    { userId, role: ROLES.HR_ADMIN }, {}, true
  );
  const profile = await authorizationService.getAccessProfile(userId);
  assert.deepEqual(profile.roles, [ROLES.HR_ADMIN, ROLES.MANAGER]);
  assert.equal(profile.permissions.includes(P.EMPLOYEE_UPDATE), true);
  assert.equal(profile.permissions.includes(P.PAYROLL_APPROVE), false);
});

test('expired elevated role assignments grant no additional permissions', async () => {
  const userId = users.get(ROLES.EMPLOYEE);
  await db.execute(
    `INSERT INTO auth_user_roles (user_id, role_id, assigned_by, expires_at)
     SELECT :userId, role_id, NULL, SYSTIMESTAMP - INTERVAL '1' MINUTE
       FROM auth_roles WHERE role_code = :role`,
    { userId, role: ROLES.SYSTEM_ADMIN }, {}, true
  );
  const profile = await authorizationService.getAccessProfile(userId);
  assert.deepEqual(profile.roles, [ROLES.EMPLOYEE]);
  assert.deepEqual(profile.permissions, expectedPermissions[ROLES.EMPLOYEE]);
});

test('employee cannot call an administrator API', async () => {
  const result = await call(ROLES.EMPLOYEE, 'GET', '/api/users');
  assert.equal(result.status, 403);
  assert.equal(result.payload.code, 'FORBIDDEN');
});

test('HR administrator cannot approve payroll', async () => {
  const result = await call(ROLES.HR_ADMIN, 'POST', '/api/payroll/runs/1/approve');
  assert.equal(result.status, 403);
});

test('payroll operator cannot access system configuration', async () => {
  const result = await call(ROLES.PAYROLL_OPERATOR, 'GET', '/api/system/configuration');
  assert.equal(result.status, 403);
});

test('system administrator cannot change their own roles', async () => {
  const result = await call(
    ROLES.SYSTEM_ADMIN,
    'PUT',
    `/api/users/${users.get(ROLES.SYSTEM_ADMIN)}/roles`,
    { roles: [ROLES.SYSTEM_ADMIN, ROLES.PAYROLL_APPROVER] }
  );
  assert.equal(result.status, 403);
  assert.equal(result.payload.code, 'SELF_ROLE_CHANGE_FORBIDDEN');
});

test('users cannot modify another user permissions directly', async () => {
  const targetId = users.get(ROLES.AUDITOR);
  const denied = await call(ROLES.EMPLOYEE, 'PUT', `/api/users/${targetId}/permissions`, { permissions: [P.SYSTEM_CONFIGURE] });
  assert.equal(denied.status, 403);
  const administrator = await call(ROLES.SYSTEM_ADMIN, 'PUT', `/api/users/${targetId}/permissions`, { permissions: [P.SYSTEM_CONFIGURE] });
  assert.equal(administrator.status, 405);
  assert.equal(administrator.payload.code, 'DIRECT_PERMISSION_ASSIGNMENT_FORBIDDEN');
});

test('unauthorized payroll upload is rejected before file processing', async () => {
  const result = await call(ROLES.EMPLOYEE, 'POST', '/api/salary/upload');
  assert.equal(result.status, 403);
  const confirmation = await call(ROLES.EMPLOYEE, 'POST', '/api/salary/upload/confirm', { previewToken: 'x'.repeat(43) });
  assert.equal(confirmation.status, 403);
});

test('unauthorized salary modification is rejected', async () => {
  const result = await call(ROLES.EMPLOYEE, 'PUT', '/api/payroll/1', {});
  assert.equal(result.status, 403);
});

test('auditor cannot mutate payroll and system admin has no payroll privilege', async () => {
  assert.equal((await call(ROLES.AUDITOR, 'DELETE', '/api/payroll/1')).status, 403);
  assert.equal((await call(ROLES.SYSTEM_ADMIN, 'POST', '/api/payroll/runs/1/approve')).status, 403);
});

test('audit access is restricted to auditor and system administrator roles', async () => {
  assert.equal((await call(ROLES.AUDITOR, 'GET', '/api/audit')).status, 200);
  assert.equal((await call(ROLES.SYSTEM_ADMIN, 'GET', '/api/audit')).status, 200);
  assert.equal((await call(ROLES.EMPLOYEE, 'GET', '/api/audit')).status, 403);
  assert.equal((await call(ROLES.PAYROLL_OPERATOR, 'GET', '/api/audit')).status, 403);
});

test('unregistered API routes fail closed', async () => {
  const result = await call(ROLES.SYSTEM_ADMIN, 'GET', '/api/unregistered-feature');
  assert.equal(result.status, 403);
  assert.equal(result.payload.code, 'AUTHORIZATION_POLICY_MISSING');
});
