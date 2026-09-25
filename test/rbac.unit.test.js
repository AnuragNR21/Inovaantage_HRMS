const test = require('node:test');
const assert = require('node:assert/strict');
const { permissionsForRequest, policies } = require('../server/authorization/routePolicies');
const { PERMISSIONS: P } = require('../server/authorization/permissions');

test('route policies require all permissions for sensitive operations', () => {
  assert.deepEqual(permissionsForRequest('POST', '/api/salary/upload'), [P.PAYROLL_UPLOAD, P.PAYROLL_PROCESS, P.SALARY_UPDATE]);
  assert.deepEqual(permissionsForRequest('POST', '/api/salary/upload/confirm'), [P.PAYROLL_UPLOAD, P.PAYROLL_PROCESS, P.SALARY_UPDATE]);
  assert.deepEqual(permissionsForRequest('PUT', '/api/users/42/roles'), [P.USER_UPDATE, P.ROLE_ASSIGN]);
  assert.deepEqual(permissionsForRequest('POST', '/api/payroll/runs/42/approve'), [P.PAYROLL_APPROVE]);
  assert.deepEqual(permissionsForRequest('POST', '/api/payroll/rows/delete'), [P.PAYROLL_DELETE]);
  assert.deepEqual(permissionsForRequest('POST', '/api/payroll/runs/42/payslips/generate'), [P.PAYSLIP_GENERATE]);
  assert.deepEqual(permissionsForRequest('GET', '/api/payroll/runs/42/payslips'), [P.PAYSLIP_VIEW]);
  assert.deepEqual(permissionsForRequest('GET', '/api/system/configuration'), [P.SYSTEM_CONFIGURE]);
  assert.deepEqual(permissionsForRequest('GET', '/api/audit'), [P.AUDIT_VIEW]);
});

test('sensitive reads accept either complete broad access or complete self access', () => {
  assert.deepEqual(permissionsForRequest('GET', '/api/payroll'), { alternatives: [
    { scope: 'ALL', permissions: [P.PAYROLL_VIEW, P.SALARY_VIEW] },
    { scope: 'SELF', permissions: [P.PAYROLL_SELF_VIEW, P.SALARY_SELF_VIEW] }
  ] });
  assert.deepEqual(permissionsForRequest('GET', '/api/payroll/42/payslip'), { alternatives: [
    { scope: 'ALL', permissions: [P.PAYSLIP_VIEW, P.PAYSLIP_DOWNLOAD] },
    { scope: 'SELF', permissions: [P.PAYSLIP_SELF_VIEW, P.PAYSLIP_SELF_DOWNLOAD] }
  ] });
});

test('route policies do not match a different method or malformed identifier', () => {
  assert.equal(permissionsForRequest('GET', '/api/salary/upload'), null);
  assert.equal(permissionsForRequest('PUT', '/api/users/me/roles'), null);
  assert.equal(permissionsForRequest('POST', '/api/payroll/runs/not-a-number/approve'), null);
});

test('each method and representative path resolves to only one policy', () => {
  const representativePath = (pattern) => pattern.source
    .replace(/^\^\\\//, '/')
    .replace(/\\d\+/g, '1')
    .replace(/\\\//g, '/')
    .replace(/\$$/, '');

  for (const [method, pattern] of policies) {
    const path = representativePath(pattern);
    const matches = policies.filter(([candidateMethod, candidatePattern]) =>
      candidateMethod === method && candidatePattern.test(path));
    assert.equal(matches.length, 1, `${method} ${path} must have exactly one policy`);
  }
});
