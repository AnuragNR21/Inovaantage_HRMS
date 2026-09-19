const db = require('../db');

async function listUsers() {
  const [usersResult, rolesResult] = await Promise.all([
    db.execute(
      `SELECT user_id, username, full_name, email, employee_id, is_active,
              must_change_password, last_login_at, created_at
         FROM app_users ORDER BY username`
    ),
    db.execute(
      `SELECT ur.user_id, r.role_code
         FROM auth_user_roles ur
         JOIN auth_roles r ON r.role_id = ur.role_id
        WHERE r.is_active = 1 AND (ur.expires_at IS NULL OR ur.expires_at > SYSTIMESTAMP)
        ORDER BY r.role_code`
    )
  ]);
  const rolesByUser = new Map();
  for (const row of rolesResult.rows) {
    if (!rolesByUser.has(row.USER_ID)) rolesByUser.set(row.USER_ID, []);
    rolesByUser.get(row.USER_ID).push(row.ROLE_CODE);
  }
  return usersResult.rows.map((row) => ({ ...row, ROLES: rolesByUser.get(row.USER_ID) || [] }));
}

async function getUser(userId, conn = null) {
  const executor = conn || db;
  const result = await executor.execute(
    `SELECT user_id, username, full_name, email, employee_id, is_active,
            must_change_password, last_login_at, created_at
       FROM app_users WHERE user_id = :userId`,
    { userId }
  );
  if (!result.rows.length) return null;
  const roles = await executor.execute(
    `SELECT r.role_code FROM auth_user_roles ur
       JOIN auth_roles r ON r.role_id = ur.role_id
      WHERE ur.user_id = :userId AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > SYSTIMESTAMP)
      ORDER BY r.role_code`,
    { userId }
  );
  return { ...result.rows[0], ROLES: roles.rows.map((row) => row.ROLE_CODE) };
}

async function resolveRoles(conn, roleCodes) {
  const resolved = [];
  for (const roleCode of roleCodes) {
    const result = await conn.execute(
      `SELECT role_id, role_code FROM auth_roles WHERE role_code = :roleCode AND is_active = 1`,
      { roleCode }
    );
    if (!result.rows.length) return null;
    resolved.push(result.rows[0]);
  }
  return resolved;
}

async function createUser({ username, passwordHash, fullName, email, employeeId, mustChangePassword, roleCodes, assignedBy }) {
  return db.withConnection(async (conn) => {
    const roles = await resolveRoles(conn, roleCodes);
    if (!roles) return { invalidRole: true };
    const result = await conn.execute(
      `INSERT INTO app_users
        (username, password_hash, full_name, email, employee_id, role, is_active,
         must_change_password, password_changed_at, password_version)
       VALUES
        (:username, :passwordHash, :fullName, :email, :employeeId, 'VIEWER', 1,
         :mustChangePassword, SYSTIMESTAMP, 1)
       RETURNING user_id INTO :newId`,
      {
        username, passwordHash, fullName, email, employeeId,
        mustChangePassword: mustChangePassword ? 1 : 0,
        newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
      }
    );
    const userId = result.outBinds.newId[0];
    for (const role of roles) {
      await conn.execute(
        `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
         VALUES (:userId, :roleId, :assignedBy)`,
        { userId, roleId: role.ROLE_ID, assignedBy }
      );
    }
    await conn.commit();
    return { userId };
  });
}

async function updateUser(userId, { fullName, email, employeeId }) {
  const result = await db.execute(
    `UPDATE app_users SET full_name = :fullName, email = :email, employee_id = :employeeId
      WHERE user_id = :userId`,
    { userId, fullName, email, employeeId }, {}, true
  );
  return result.rowsAffected;
}

async function countActiveSystemAdmins(conn = null) {
  const executor = conn || db;
  const result = await executor.execute(
    `SELECT COUNT(DISTINCT u.user_id) AS cnt
       FROM app_users u
       JOIN auth_user_roles ur ON ur.user_id = u.user_id
       JOIN auth_roles r ON r.role_id = ur.role_id
      WHERE u.is_active = 1 AND r.role_code = 'SYSTEM_ADMIN'
        AND r.is_active = 1 AND (ur.expires_at IS NULL OR ur.expires_at > SYSTIMESTAMP)`
  );
  return Number(result.rows[0].CNT);
}

async function lockSystemAdminRole(conn) {
  const result = await conn.execute(
    `SELECT role_id FROM auth_roles
      WHERE role_code = 'SYSTEM_ADMIN' AND is_active = 1
      FOR UPDATE`
  );
  return result.rows.length ? result.rows[0].ROLE_ID : null;
}

async function deactivateUser(userId) {
  return db.withConnection(async (conn) => {
    const systemAdminRoleId = await lockSystemAdminRole(conn);
    if (systemAdminRoleId) {
      const assignment = await conn.execute(
        `SELECT 1 AS assigned FROM auth_user_roles
          WHERE user_id = :userId AND role_id = :roleId
            AND (expires_at IS NULL OR expires_at > SYSTIMESTAMP)`,
        { userId, roleId: systemAdminRoleId }
      );
      if (assignment.rows.length && await countActiveSystemAdmins(conn) <= 1) {
        return { lastSystemAdmin: true };
      }
    }
    const result = await conn.execute(
      `UPDATE app_users SET is_active = 0 WHERE user_id = :userId AND is_active = 1`,
      { userId }
    );
    await conn.execute(
      `UPDATE user_sessions SET revoked_at = SYSTIMESTAMP, revoked_reason = 'ACCOUNT_DEACTIVATED'
        WHERE user_id = :userId AND revoked_at IS NULL`,
      { userId }
    );
    await conn.commit();
    return { rowsAffected: result.rowsAffected };
  });
}

async function replaceRoles(userId, roleCodes, assignedBy) {
  return db.withConnection(async (conn) => {
    const roles = await resolveRoles(conn, roleCodes);
    if (!roles) return { invalidRole: true };
    const systemAdminRoleId = await lockSystemAdminRole(conn);
    const exists = await conn.execute(`SELECT user_id FROM app_users WHERE user_id = :userId`, { userId });
    if (!exists.rows.length) return { notFound: true };
    if (systemAdminRoleId && !roles.some((role) => role.ROLE_ID === systemAdminRoleId)) {
      const assignment = await conn.execute(
        `SELECT 1 AS assigned FROM auth_user_roles
          WHERE user_id = :userId AND role_id = :roleId
            AND (expires_at IS NULL OR expires_at > SYSTIMESTAMP)`,
        { userId, roleId: systemAdminRoleId }
      );
      if (assignment.rows.length && await countActiveSystemAdmins(conn) <= 1) {
        return { lastSystemAdmin: true };
      }
    }
    await conn.execute(`DELETE FROM auth_user_roles WHERE user_id = :userId`, { userId });
    for (const role of roles) {
      await conn.execute(
        `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
         VALUES (:userId, :roleId, :assignedBy)`,
        { userId, roleId: role.ROLE_ID, assignedBy }
      );
    }
    await conn.commit();
    return { success: true };
  });
}

module.exports = {
  listUsers, getUser, createUser, updateUser, countActiveSystemAdmins,
  deactivateUser, replaceRoles
};
