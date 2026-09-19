const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMetadata } = require('../server/services/auditService');

test('audit metadata removes credentials, tokens, and document contents', () => {
  const result = safeMetadata({
    username: 'auditor',
    password: 'never-store',
    sessionToken: 'secret-token',
    authorization: 'Bearer secret',
    documentContent: 'pdf-bytes',
    payrollId: 42,
    fields: ['email', 'status']
  });
  assert.deepEqual(result, { username: 'auditor', payrollId: 42, fields: ['email', 'status'] });
});

test('audit metadata handles absent and primitive values safely', () => {
  assert.equal(safeMetadata(null), undefined);
  assert.equal(safeMetadata('secret'), undefined);
});
