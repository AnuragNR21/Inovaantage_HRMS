const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const authService = require('../server/services/authService');
const sessionStore = require('../server/utils/sessionStore');
const authController = require('../server/controllers/authController');
const { hashPassword } = require('../server/services/passwordService');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const activeUsername = `auth_active_${suffix}`;
const inactiveUsername = `auth_inactive_${suffix}`;
const validPassword = 'Integration-Secure-42!';
let activeUserId;

test.before(async () => {
  await db.initPool();
  const passwordHash = await hashPassword(validPassword, { username: activeUsername });
  const active = await db.execute(
    `INSERT INTO app_users
      (username, password_hash, full_name, role, is_active, must_change_password, password_version)
     VALUES (:username, :passwordHash, 'Authentication Test', 'VIEWER', 1, 0, 1)
     RETURNING user_id INTO :newId`,
    {
      username: activeUsername,
      passwordHash,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }, {}, true
  );
  activeUserId = active.outBinds.newId[0];
  await db.execute(
    `INSERT INTO app_users
      (username, password_hash, full_name, role, is_active, must_change_password, password_version)
     VALUES (:username, :passwordHash, 'Inactive Authentication Test', 'VIEWER', 0, 0, 1)`,
    { username: inactiveUsername, passwordHash }, {}, true
  );
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    await conn.execute(`DELETE FROM password_reset_tokens WHERE user_id IN (SELECT user_id FROM app_users WHERE username IN (:active, :inactive))`, { active: activeUsername, inactive: inactiveUsername });
    await conn.execute(`DELETE FROM user_sessions WHERE user_id IN (SELECT user_id FROM app_users WHERE username IN (:active, :inactive))`, { active: activeUsername, inactive: inactiveUsername });
    await conn.execute(`DELETE FROM app_users WHERE username IN (:active, :inactive)`, { active: activeUsername, inactive: inactiveUsername });
    await conn.execute(`DELETE FROM auth_login_attempts WHERE username_hash IN (:activeHash, :inactiveHash)`, {
      activeHash: authService.sha256(activeUsername.toLowerCase()),
      inactiveHash: authService.sha256(inactiveUsername.toLowerCase())
    });
    await conn.commit();
  });
  await db.closePool();
});

test('valid login creates a hashed persistent session', async () => {
  const result = await authService.login({ username: activeUsername, password: validPassword, ipAddress: '127.0.0.10', userAgent: 'test' });
  assert.equal(result.user.username, activeUsername);
  assert.equal(result.token.length > 32, true);
  const stored = await db.execute(`SELECT token_hash FROM user_sessions WHERE user_id = :id AND revoked_at IS NULL`, { id: activeUserId });
  assert.ok(stored.rows.length);
  assert.notEqual(stored.rows[0].TOKEN_HASH, result.token);
  assert.equal((await sessionStore.getSession(result.token)).userId, activeUserId);
});

test('invalid password and inactive account return generic authentication failure', async () => {
  await assert.rejects(
    authService.login({ username: activeUsername, password: 'Wrong-Password-42!', ipAddress: '127.0.0.11' }),
    (err) => err.statusCode === 401 && err.code === 'AUTH_INVALID_CREDENTIALS'
  );
  await assert.rejects(
    authService.login({ username: inactiveUsername, password: validPassword, ipAddress: '127.0.0.12' }),
    (err) => err.statusCode === 401 && err.code === 'AUTH_INVALID_CREDENTIALS'
  );
});

test('expired and logged-out sessions are rejected', async () => {
  const first = await authService.login({ username: activeUsername, password: validPassword, ipAddress: '127.0.0.13' });
  await db.execute(`UPDATE user_sessions SET expires_at = SYSTIMESTAMP - INTERVAL '1' MINUTE WHERE token_hash = :hash`, { hash: sessionStore.hashToken(first.token) }, {}, true);
  assert.equal(await sessionStore.getSession(first.token), null);

  const second = await authService.login({ username: activeUsername, password: validPassword, ipAddress: '127.0.0.14' });
  await sessionStore.destroySession(second.token);
  assert.equal(await sessionStore.getSession(second.token), null);
});

test('authentication middleware rejects missing sessions and logout revokes a session', async () => {
  const response = () => {
    const headers = new Map();
    return {
      statusCode: null,
      body: '',
      getHeader: (name) => headers.get(name),
      setHeader: (name, value) => headers.set(name, value),
      writeHead(statusCode, values) {
        this.statusCode = statusCode;
        Object.entries(values || {}).forEach(([name, value]) => headers.set(name, value));
      },
      end(body) { this.body = body || ''; }
    };
  };

  const unauthenticatedResponse = response();
  const allowed = await authController.requireAuth({ headers: {}, socket: {} }, unauthenticatedResponse);
  assert.equal(allowed, false);
  assert.equal(unauthenticatedResponse.statusCode, 401);

  const login = await authService.login({ username: activeUsername, password: validPassword, ipAddress: '127.0.0.15' });
  const logoutResponse = response();
  await authController.logout({ headers: { cookie: `payroll_sid=${login.token}` } }, logoutResponse);
  assert.equal(logoutResponse.statusCode, 200);
  assert.equal(await sessionStore.getSession(login.token), null);
  assert.match(String(logoutResponse.getHeader('Set-Cookie')), /Max-Age=0/);
});

test('repeated failures trigger persisted rate limiting', async () => {
  const ipAddress = '127.0.0.99';
  for (let i = 0; i < 5; i++) {
    await assert.rejects(authService.login({ username: activeUsername, password: 'Wrong-Password-42!', ipAddress }));
  }
  await assert.rejects(
    authService.login({ username: activeUsername, password: validPassword, ipAddress }),
    (err) => err.statusCode === 429 && err.code === 'AUTH_RATE_LIMITED'
  );
});
