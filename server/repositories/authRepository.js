const db = require('../db');

async function findUserByUsername(username) {
  const result = await db.execute(
    `SELECT u.user_id, u.username, u.password_hash, u.full_name, u.role, u.is_active,
            u.employee_id, u.email, u.failed_login_count, u.locked_until,
            u.password_version, u.must_change_password,
            COALESCE(u.email, e.email) AS recovery_email
       FROM app_users u
       LEFT JOIN employees e ON e.employee_id = u.employee_id
      WHERE LOWER(u.username) = LOWER(:username)`,
    { username }
  );
  return result.rows[0] || null;
}

async function findUserById(userId) {
  const result = await db.execute(
    `SELECT user_id, username, password_hash, full_name, role, is_active,
            employee_id, email, failed_login_count, locked_until,
            password_version, must_change_password
       FROM app_users WHERE user_id = :userId`,
    { userId }
  );
  return result.rows[0] || null;
}

async function getRecentFailureCounts(usernameHash, ipAddress, since) {
  const result = await db.execute(
    `SELECT
       SUM(CASE WHEN username_hash = :usernameHash THEN 1 ELSE 0 END) AS username_count,
       SUM(CASE WHEN ip_address = :ipAddress THEN 1 ELSE 0 END) AS ip_count
     FROM auth_login_attempts
     WHERE success = 0 AND attempted_at >= :since`,
    { usernameHash, ipAddress, since }
  );
  return {
    username: Number(result.rows[0].USERNAME_COUNT || 0),
    ip: Number(result.rows[0].IP_COUNT || 0)
  };
}

async function recordAttempt({ usernameHash, ipAddress, success }) {
  await db.execute(
    `INSERT INTO auth_login_attempts (username_hash, ip_address, success)
     VALUES (:usernameHash, :ipAddress, :success)`,
    { usernameHash, ipAddress, success: success ? 1 : 0 },
    {},
    true
  );
}

async function recordFailedLogin(userId, lockUntil) {
  if (!userId) return;
  if (lockUntil) {
    await db.execute(
      `UPDATE app_users
          SET failed_login_count = failed_login_count + 1,
              last_failed_login_at = SYSTIMESTAMP,
              locked_until = :lockUntil
        WHERE user_id = :userId`,
      { userId, lockUntil },
      {},
      true
    );
  } else {
    await db.execute(
      `UPDATE app_users
          SET failed_login_count = failed_login_count + 1,
              last_failed_login_at = SYSTIMESTAMP
        WHERE user_id = :userId`,
      { userId },
      {},
      true
    );
  }
}

async function recordSuccessfulLogin(userId) {
  await db.execute(
    `UPDATE app_users
        SET failed_login_count = 0, locked_until = NULL, last_login_at = SYSTIMESTAMP
      WHERE user_id = :userId`,
    { userId },
    {},
    true
  );
}

async function clearRecentFailures(usernameHash) {
  await db.execute(
    `DELETE FROM auth_login_attempts WHERE username_hash = :usernameHash`,
    { usernameHash },
    {},
    true
  );
}

async function updatePassword(userId, passwordHash) {
  await db.withConnection(async (conn) => {
    await conn.execute(
      `UPDATE app_users
          SET password_hash = :passwordHash,
              password_changed_at = SYSTIMESTAMP,
              password_version = password_version + 1,
              must_change_password = 0,
              failed_login_count = 0,
              locked_until = NULL
        WHERE user_id = :userId`,
      { userId, passwordHash }
    );
    await conn.execute(
      `UPDATE user_sessions SET revoked_at = SYSTIMESTAMP, revoked_reason = 'PASSWORD_CHANGED'
        WHERE user_id = :userId AND revoked_at IS NULL`,
      { userId }
    );
    await conn.commit();
  });
}

async function createPasswordResetToken({ tokenHash, userId, expiresAt, requestedIp }) {
  await db.withConnection(async (conn) => {
    await conn.execute(
      `UPDATE password_reset_tokens SET used_at = SYSTIMESTAMP
        WHERE user_id = :userId AND used_at IS NULL`,
      { userId }
    );
    await conn.execute(
      `INSERT INTO password_reset_tokens
        (token_hash, user_id, expires_at, requested_ip)
       VALUES (:tokenHash, :userId, :expiresAt, :requestedIp)`,
      { tokenHash, userId, expiresAt, requestedIp }
    );
    await conn.commit();
  });
}

async function hasActivePasswordResetToken(userId) {
  const result = await db.execute(
    `SELECT COUNT(*) AS cnt FROM password_reset_tokens
      WHERE user_id = :userId AND used_at IS NULL AND expires_at > SYSTIMESTAMP`,
    { userId }
  );
  return Number(result.rows[0].CNT) > 0;
}

async function invalidatePasswordResetToken(tokenHash) {
  await db.execute(
    `UPDATE password_reset_tokens SET used_at = SYSTIMESTAMP
      WHERE token_hash = :tokenHash AND used_at IS NULL`,
    { tokenHash },
    {},
    true
  );
}

async function consumePasswordResetToken(tokenHash, passwordHash) {
  return db.withConnection(async (conn) => {
    const result = await conn.execute(
      `SELECT token_hash, user_id
         FROM password_reset_tokens
        WHERE token_hash = :tokenHash AND used_at IS NULL AND expires_at > SYSTIMESTAMP
        FOR UPDATE`,
      { tokenHash }
    );
    if (!result.rows.length) return false;
    const userId = result.rows[0].USER_ID;
    const updated = await conn.execute(
      `UPDATE app_users
          SET password_hash = :passwordHash, password_changed_at = SYSTIMESTAMP,
              password_version = password_version + 1, must_change_password = 0,
              failed_login_count = 0, locked_until = NULL
        WHERE user_id = :userId AND is_active = 1`,
      { passwordHash, userId }
    );
    if (updated.rowsAffected !== 1) return false;
    await conn.execute(
      `UPDATE password_reset_tokens SET used_at = SYSTIMESTAMP WHERE token_hash = :tokenHash`,
      { tokenHash }
    );
    await conn.execute(
      `UPDATE user_sessions SET revoked_at = SYSTIMESTAMP, revoked_reason = 'PASSWORD_RESET'
        WHERE user_id = :userId AND revoked_at IS NULL`,
      { userId }
    );
    await conn.commit();
    return true;
  });
}

async function findPasswordResetUser(tokenHash) {
  const result = await db.execute(
    `SELECT u.user_id, u.username
       FROM password_reset_tokens t
       JOIN app_users u ON u.user_id = t.user_id
      WHERE t.token_hash = :tokenHash AND t.used_at IS NULL
        AND t.expires_at > SYSTIMESTAMP AND u.is_active = 1`,
    { tokenHash }
  );
  return result.rows[0] || null;
}

module.exports = {
  findUserByUsername,
  findUserById,
  getRecentFailureCounts,
  recordAttempt,
  recordFailedLogin,
  recordSuccessfulLogin,
  clearRecentFailures,
  updatePassword,
  createPasswordResetToken,
  hasActivePasswordResetToken,
  invalidatePasswordResetToken,
  findPasswordResetUser,
  consumePasswordResetToken
};
