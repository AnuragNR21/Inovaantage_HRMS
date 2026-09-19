const userService = require('../services/userService');
const { sendJson, sendError, readJsonBody } = require('../utils/http');
const auditService = require('../services/auditService');

function handleError(res, err) {
  if (err instanceof userService.UserManagementError) {
    return sendError(res, err.statusCode, err.message, err.code);
  }
  console.error('[users] error', err);
  return sendError(res, 500, 'User management operation failed.', 'USER_MANAGEMENT_ERROR');
}

async function listUsers(req, res) {
  try { return sendJson(res, 200, { success: true, users: await userService.listUsers() }); }
  catch (err) { return handleError(res, err); }
}

async function getUser(req, res, userId) {
  try { return sendJson(res, 200, { success: true, user: await userService.getUser(userId) }); }
  catch (err) { return handleError(res, err); }
}

async function createUser(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    const result = await userService.createUser(body, req.session.userId);
    await auditService.record({ actorUserId: req.session.userId, action: 'USER_CREATED', resourceType: 'USER', resourceId: result.userId, metadata: { username: body.username, roleCount: Array.isArray(body.roles) ? body.roles.length : 0 } });
    return sendJson(res, 201, { success: true, userId: result.userId });
  } catch (err) { return handleError(res, err); }
}

async function updateUser(req, res, userId) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    await userService.updateUser(userId, body);
    await auditService.record({ actorUserId: req.session.userId, action: 'USER_MODIFIED', resourceType: 'USER', resourceId: userId, metadata: { fields: Object.keys(body || {}).filter((key) => key !== 'password') } });
    return sendJson(res, 200, { success: true });
  } catch (err) { return handleError(res, err); }
}

async function deactivateUser(req, res, userId) {
  try {
    await userService.deactivateUser(userId, req.session.userId);
    await auditService.record({ actorUserId: req.session.userId, action: 'USER_DEACTIVATED', resourceType: 'USER', resourceId: userId });
    return sendJson(res, 200, { success: true });
  } catch (err) { return handleError(res, err); }
}

async function replaceRoles(req, res, userId) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    await userService.replaceRoles(userId, body.roles, req.session.userId);
    await auditService.record({ actorUserId: req.session.userId, action: 'ROLE_CHANGED', resourceType: 'USER', resourceId: userId, metadata: { roles: Array.isArray(body.roles) ? body.roles : [] } });
    return sendJson(res, 200, { success: true });
  } catch (err) { return handleError(res, err); }
}

async function listRoles(req, res) {
  try { return sendJson(res, 200, { success: true, roles: await userService.listRoles() }); }
  catch (err) { return handleError(res, err); }
}

function rejectDirectPermissions(req, res) {
  auditService.record({ actorUserId: req.session.userId, action: 'PERMISSION_CHANGE_DENIED', resourceType: 'USER', resourceId: req.url, result: 'DENIED' });
  return sendError(res, 405, 'Permissions are assigned to roles, not directly to users.', 'DIRECT_PERMISSION_ASSIGNMENT_FORBIDDEN');
}

module.exports = {
  listUsers, getUser, createUser, updateUser, deactivateUser,
  replaceRoles, listRoles, rejectDirectPermissions
};
