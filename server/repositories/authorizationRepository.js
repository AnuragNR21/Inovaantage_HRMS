const db = require('../db');

async function getAccessProfile(userId) {
  const [roleResult, permissionResult] = await Promise.all([
    db.execute(
      `SELECT DISTINCT r.role_code, r.role_name
         FROM auth_user_roles ur
         JOIN auth_roles r ON r.role_id = ur.role_id
        WHERE ur.user_id = :userId AND r.is_active = 1
          AND (ur.expires_at IS NULL OR ur.expires_at > SYSTIMESTAMP)
        ORDER BY r.role_code`,
      { userId }
    ),
    db.execute(
      `SELECT DISTINCT p.permission_code
         FROM auth_user_roles ur
         JOIN auth_roles r ON r.role_id = ur.role_id AND r.is_active = 1
         JOIN auth_role_permissions rp ON rp.role_id = r.role_id
         JOIN auth_permissions p ON p.permission_id = rp.permission_id AND p.is_active = 1
        WHERE ur.user_id = :userId
          AND (ur.expires_at IS NULL OR ur.expires_at > SYSTIMESTAMP)
        ORDER BY p.permission_code`,
      { userId }
    )
  ]);
  return {
    roles: roleResult.rows.map((row) => row.ROLE_CODE),
    permissions: permissionResult.rows.map((row) => row.PERMISSION_CODE)
  };
}

async function listRoles() {
  const result = await db.execute(
    `SELECT r.role_id, r.role_code, r.role_name, r.description,
            p.permission_code
       FROM auth_roles r
       LEFT JOIN auth_role_permissions rp ON rp.role_id = r.role_id
       LEFT JOIN auth_permissions p ON p.permission_id = rp.permission_id
      WHERE r.is_active = 1
      ORDER BY r.role_code, p.permission_code`
  );
  const roles = new Map();
  for (const row of result.rows) {
    if (!roles.has(row.ROLE_ID)) {
      roles.set(row.ROLE_ID, {
        roleId: row.ROLE_ID,
        code: row.ROLE_CODE,
        name: row.ROLE_NAME,
        description: row.DESCRIPTION,
        permissions: []
      });
    }
    if (row.PERMISSION_CODE) roles.get(row.ROLE_ID).permissions.push(row.PERMISSION_CODE);
  }
  return [...roles.values()];
}

module.exports = { getAccessProfile, listRoles };
