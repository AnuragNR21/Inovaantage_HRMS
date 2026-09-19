require('dotenv').config();
const db = require('../server/db');
const { hashPassword, validatePassword } = require('../server/services/passwordService');

async function main() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  const fullName = String(process.env.ADMIN_FULL_NAME || 'System Administrator').trim();
  const email = String(process.env.ADMIN_EMAIL || '').trim() || null;

  if (!username || !password) throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment.');
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) throw new Error('ADMIN_USERNAME has an invalid format.');
  const errors = validatePassword(password, { username });
  if (errors.length) throw new Error(errors.join(' '));

  await db.initPool();
  const existing = await db.execute(
    `SELECT user_id FROM app_users WHERE LOWER(username) = LOWER(:username)`,
    { username }
  );
  if (existing.rows.length) throw new Error('That administrator username already exists.');
  const passwordHash = await hashPassword(password, { username });
  await db.withConnection(async (conn) => {
    const result = await conn.execute(
      `INSERT INTO app_users
        (username, password_hash, full_name, email, role, is_active, must_change_password,
         password_changed_at, password_version)
       VALUES (:username, :passwordHash, :fullName, :email, 'ADMIN', 1, 0, SYSTIMESTAMP, 1)
       RETURNING user_id INTO :newId`,
      {
        username, passwordHash, fullName, email,
        newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
      }
    );
    const userId = result.outBinds.newId[0];
    const roleCodes = ['SYSTEM_ADMIN', 'HR_ADMIN', 'PAYROLL_OPERATOR', 'PAYROLL_APPROVER'];
    for (const roleCode of roleCodes) {
      const assigned = await conn.execute(
        `INSERT INTO auth_user_roles (user_id, role_id, assigned_by)
         SELECT :userId, role_id, :userId FROM auth_roles WHERE role_code = :roleCode`,
        { userId, roleCode }
      );
      if (assigned.rowsAffected !== 1) {
        throw new Error('RBAC roles are missing. Run npm run migrate:rbac first.');
      }
    }
    await conn.commit();
  });
  console.log(`Administrator ${username} created.`);
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => db.closePool().catch(() => {}));
