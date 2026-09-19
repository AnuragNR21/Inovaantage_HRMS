const test = require('node:test');
const assert = require('node:assert/strict');
const { setCookie, clearCookie, parseCookies } = require('../server/utils/http');

function response() {
  const headers = new Map();
  return {
    getHeader: (name) => headers.get(name),
    setHeader: (name, value) => headers.set(name, value),
    headers
  };
}

test('session cookie is HttpOnly, strict and secure when requested', () => {
  const res = response();
  setCookie(res, 'payroll_sid', 'secret-token', { maxAge: 60, sameSite: 'Strict', secure: true });
  const cookie = res.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=60/);
});

test('clearCookie emits Max-Age=0', () => {
  const res = response();
  clearCookie(res, 'payroll_sid');
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('malformed cookies do not crash parsing', () => {
  assert.deepEqual(parseCookies({ headers: { cookie: 'bad=%E0%A4%A; good=value' } }), { good: 'value' });
});
