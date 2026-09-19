const crypto = require('crypto');
const db = require('../db');
const { getAuthConfig } = require('../config');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function createSession(user, metadata = {}) {
  const config = getAuthConfig();
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const now = Date.now();
  const expiresAt = new Date(now + config.sessionTtlMinutes * 60 * 1000);
  const absoluteExpiresAt = new Date(now + config.sessionAbsoluteTtlMinutes * 60 * 1000);

  await db.execute(
    `INSERT INTO user_sessions
      (token_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at,
       ip_address, user_agent, password_version)
     VALUES
      (:tokenHash, :userId, SYSTIMESTAMP, SYSTIMESTAMP, :expiresAt, :absoluteExpiresAt,
       :ipAddress, :userAgent, :passwordVersion)`,
    {
      tokenHash,
      userId: user.USER_ID,
      expiresAt,
      absoluteExpiresAt,
      ipAddress: metadata.ipAddress || null,
      userAgent: String(metadata.userAgent || '').slice(0, 500) || null,
      passwordVersion: user.PASSWORD_VERSION || 1
    },
    {},
    true
  );

  return { token, expiresAt, absoluteExpiresAt };
}

async function getSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const tokenHash = hashToken(token);
  const result = await db.execute(
    `SELECT s.token_hash, s.user_id, s.expires_at, s.absolute_expires_at,
            u.username, u.full_name, u.role, u.employee_id, u.must_change_password
       FROM user_sessions s
       JOIN app_users u ON u.user_id = s.user_id
      WHERE s.token_hash = :tokenHash
        AND s.revoked_at IS NULL
        AND s.expires_at > SYSTIMESTAMP
        AND s.absolute_expires_at > SYSTIMESTAMP
        AND s.password_version = u.password_version
        AND u.is_active = 1`,
    { tokenHash }
  );
  if (!result.rows.length) return null;

  const row = result.rows[0];
  const proposedExpiry = new Date(Date.now() + getAuthConfig().sessionTtlMinutes * 60 * 1000);
  await db.execute(
    `UPDATE user_sessions
        SET last_seen_at = SYSTIMESTAMP,
            expires_at = LEAST(:proposedExpiry, absolute_expires_at)
      WHERE token_hash = :tokenHash AND revoked_at IS NULL`,
    { proposedExpiry, tokenHash },
    {},
    true
  );

  return {
    tokenHash,
    userId: row.USER_ID,
    username: row.USERNAME,
    fullName: row.FULL_NAME,
    role: row.ROLE,
    employeeId: row.EMPLOYEE_ID,
    mustChangePassword: row.MUST_CHANGE_PASSWORD === 1,
    absoluteExpiresAt: row.ABSOLUTE_EXPIRES_AT
  };
}

async function destroySession(token, reason = 'LOGOUT') {
  if (!token) return;
  await db.execute(
    `UPDATE user_sessions SET revoked_at = SYSTIMESTAMP, revoked_reason = :reason
      WHERE token_hash = :tokenHash AND revoked_at IS NULL`,
    { tokenHash: hashToken(token), reason },
    {},
    true
  );
}

async function destroyUserSessions(userId, reason = 'ADMIN_REVOKED') {
  await db.execute(
    `UPDATE user_sessions SET revoked_at = SYSTIMESTAMP, revoked_reason = :reason
      WHERE user_id = :userId AND revoked_at IS NULL`,
    { userId, reason },
    {},
    true
  );
}

async function cleanupExpiredSessions() {
  await db.execute(
    `DELETE FROM user_sessions
      WHERE absolute_expires_at < SYSTIMESTAMP - INTERVAL '1' DAY
         OR revoked_at < SYSTIMESTAMP - INTERVAL '7' DAY`,
    {},
    {},
    true
  );
}

module.exports = {
  hashToken,
  createSession,
  getSession,
  destroySession,
  destroyUserSessions,
  cleanupExpiredSessions
};
