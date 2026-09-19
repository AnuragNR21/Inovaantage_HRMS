const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePassword, hashPassword, verifyPassword } = require('../server/services/passwordService');

test('password policy rejects weak passwords and username inclusion', () => {
  const errors = validatePassword('admin123', { username: 'admin' });
  assert.ok(errors.length >= 4);
  assert.ok(errors.some((message) => message.includes('username')));
});

test('password hashing and verification never store plaintext', async () => {
  const password = 'Valid-Test-Password-42!';
  const hash = await hashPassword(password, { username: 'testuser' });
  assert.notEqual(hash, password);
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('Wrong-Test-Password-42!', hash), false);
});

test('missing hash follows the safe verification path and fails', async () => {
  assert.equal(await verifyPassword('Anything-Strong-42!', null), false);
});
