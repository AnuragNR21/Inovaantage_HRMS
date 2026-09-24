const userRepository = require('../repositories/userRepository');
const authorizationRepository = require('../repositories/authorizationRepository');
const { hashPassword, validatePassword } = require('./passwordService');
const { ROLES } = require('../authorization/permissions');

class UserManagementError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return [...new Set(roles.map((role) => String(role).trim().toUpperCase()).filter(Boolean))];
}

function validateUsername(username) {
  return /^[A-Za-z0-9._-]{3,60}$/.test(String(username || '').trim());
}

async function listUsers() {
  return userRepository.listUsers();
}

async function getUser(userId) {
  const user = await userRepository.getUser(userId);
  if (!user) throw new UserManagementError(404, 'USER_NOT_FOUND', 'User not found.');
  return user;
}

async function createUser(body, actorUserId) {
  const username = String(body.username || '').trim();
  const password = typeof body.password === 'string' ? body.password : '';
  const roleCodes = normalizeRoles(body.roles);
  if (!validateUsername(username)) throw new UserManagementError(400, 'USER_INVALID', 'Username format is invalid.');
  if (!roleCodes.length) throw new UserManagementError(400, 'ROLE_REQUIRED', 'At least one role is required.');
  const errors = validatePassword(password, { username });
  if (errors.length) throw new UserManagementError(400, 'PASSWORD_POLICY', errors.join(' '));
  const passwordHash = await hashPassword(password, { username });
  try {
    const result = await userRepository.createUser({
      username,
      passwordHash,
      fullName: String(body.fullName || '').trim() || null,
      email: String(body.email || '').trim() || null,
      employeeId: body.employeeId == null ? null : Number(body.employeeId),
      mustChangePassword: body.mustChangePassword !== false,
      roleCodes,
      assignedBy: actorUserId
    });
    if (result.invalidRole) throw new UserManagementError(400, 'ROLE_INVALID', 'One or more roles are invalid.');
    return result;
  } catch (err) {
    if (err.errorNum === 1) throw new UserManagementError(409, 'USERNAME_EXISTS', 'Username already exists.');
    throw err;
  }
}

async function updateUser(userId, body) {
  const affected = await userRepository.updateUser(userId, {
    fullName: String(body.fullName || '').trim() || null,
    email: String(body.email || '').trim() || null,
    employeeId: body.employeeId == null ? null : Number(body.employeeId)
  });
  if (!affected) throw new UserManagementError(404, 'USER_NOT_FOUND', 'User not found.');
}

async function ensureNotLastSystemAdmin(user, newRoles = null) {
  if (!user.ROLES.includes(ROLES.SYSTEM_ADMIN)) return;
  if (newRoles && newRoles.includes(ROLES.SYSTEM_ADMIN)) return;
  if (await userRepository.countActiveSystemAdmins() <= 1) {
    throw new UserManagementError(409, 'LAST_SYSTEM_ADMIN', 'The last active system administrator cannot be removed.');
  }
}

async function deactivateUser(userId, actorUserId) {
  if (userId === actorUserId) throw new UserManagementError(403, 'SELF_DEACTIVATION_FORBIDDEN', 'You cannot deactivate your own account.');
  const user = await getUser(userId);
  await ensureNotLastSystemAdmin(user);
  const result = await userRepository.deactivateUser(userId);
  if (result.lastSystemAdmin) throw new UserManagementError(409, 'LAST_SYSTEM_ADMIN', 'The last active system administrator cannot be removed.');
  if (!result.rowsAffected) throw new UserManagementError(404, 'USER_NOT_FOUND', 'User not found.');
}

async function activateUser(userId) {
  const result = await userRepository.activateUser(userId);
  if (!result.rowsAffected) throw new UserManagementError(404, 'USER_NOT_FOUND', 'User not found.');
}

async function deleteUser(userId, actorUserId) {
  if (userId === actorUserId) throw new UserManagementError(403, 'SELF_DELETION_FORBIDDEN', 'You cannot delete your own account.');
  const user = await getUser(userId);
  await ensureNotLastSystemAdmin(user);
  const result = await userRepository.deleteUser(userId);
  if (result.blocked) {
    throw new UserManagementError(409, 'USER_HAS_HISTORY', 'This user owns payroll or import history and cannot be deleted. Deactivate the account instead.');
  }
  if (!result.rowsAffected) throw new UserManagementError(404, 'USER_NOT_FOUND', 'User not found.');
}

async function replaceRoles(userId, roles, actorUserId) {
  if (userId === actorUserId) throw new UserManagementError(403, 'SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own roles.');
  const roleCodes = normalizeRoles(roles);
  if (!roleCodes.length) throw new UserManagementError(400, 'ROLE_REQUIRED', 'At least one role is required.');
  const user = await getUser(userId);
  await ensureNotLastSystemAdmin(user, roleCodes);
  const result = await userRepository.replaceRoles(userId, roleCodes, actorUserId);
  if (result.invalidRole) throw new UserManagementError(400, 'ROLE_INVALID', 'One or more roles are invalid.');
  if (result.notFound) throw new UserManagementError(404, 'USER_NOT_FOUND', 'User not found.');
  if (result.lastSystemAdmin) throw new UserManagementError(409, 'LAST_SYSTEM_ADMIN', 'The last active system administrator cannot be removed.');
}

async function listRoles() {
  return authorizationRepository.listRoles();
}

module.exports = {
  UserManagementError, listUsers, getUser, createUser, updateUser,
  deactivateUser, activateUser, deleteUser, replaceRoles, listRoles
};
