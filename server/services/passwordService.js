const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getAuthConfig } = require('../config');

let dummyHashPromise;

function validatePassword(password, context = {}) {
  const { passwordMinLength, passwordMaxLength } = getAuthConfig();
  const value = typeof password === 'string' ? password : '';
  const errors = [];

  if (value.length < passwordMinLength) errors.push(`Password must be at least ${passwordMinLength} characters.`);
  if (Buffer.byteLength(value, 'utf8') > passwordMaxLength) {
    errors.push(`Password must be no more than ${passwordMaxLength} UTF-8 bytes.`);
  }
  if (!/[a-z]/.test(value)) errors.push('Password must contain a lowercase letter.');
  if (!/[A-Z]/.test(value)) errors.push('Password must contain an uppercase letter.');
  if (!/[0-9]/.test(value)) errors.push('Password must contain a number.');
  if (!/[^A-Za-z0-9]/.test(value)) errors.push('Password must contain a special character.');

  const username = String(context.username || '').trim().toLowerCase();
  if (username.length >= 3 && value.toLowerCase().includes(username)) {
    errors.push('Password must not contain the username.');
  }
  return errors;
}

async function hashPassword(password, context = {}) {
  const errors = validatePassword(password, context);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { code: 'PASSWORD_POLICY' });
  return bcrypt.hash(password, getAuthConfig().bcryptRounds);
}

async function verifyPassword(password, passwordHash) {
  const { passwordMaxLength, bcryptRounds } = getAuthConfig();
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > passwordMaxLength) return false;

  if (!dummyHashPromise) {
    const randomValue = crypto.randomBytes(32).toString('base64url');
    dummyHashPromise = bcrypt.hash(randomValue, bcryptRounds);
  }
  const hash = passwordHash || await dummyHashPromise;
  try {
    return await bcrypt.compare(password, hash);
  } catch (err) {
    return false;
  }
}

module.exports = { validatePassword, hashPassword, verifyPassword };
