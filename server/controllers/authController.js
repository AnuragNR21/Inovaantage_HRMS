const { sendJson, sendError, readJsonBody, setCookie, clearCookie, parseCookies } = require('../utils/http');
const sessionStore = require('../utils/sessionStore');
const authService = require('../services/authService');
const { getAuthConfig } = require('../config');
const authorizationService = require('../services/authorizationService');
const auditService = require('../services/auditService');

const COOKIE_NAME = 'payroll_sid';

function requestMetadata(req) {
  return { ipAddress: req.socket && req.socket.remoteAddress, userAgent: req.headers['user-agent'] };
}

function cookieOptions() {
  const config = getAuthConfig();
  return {
    maxAge: config.sessionAbsoluteTtlMinutes * 60,
    sameSite: 'Strict',
    secure: config.cookieSecure
  };
}

function handleAuthError(res, err, context) {
  if (err instanceof authService.AuthError) return sendError(res, err.statusCode, err.message, err.code);
  console.error(`[auth] ${context}`, err);
  return sendError(res, 500, 'Authentication service is unavailable.', 'AUTH_SERVICE_ERROR');
}

async function login(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    const result = await authService.login({ ...body, ...requestMetadata(req) });
    const access = await authorizationService.getAccessProfile(result.user.userId);
    await auditService.record({ actorUserId: result.user.userId, action: 'LOGIN', resourceType: 'SESSION', result: 'SUCCESS', ...requestMetadata(req) });
    setCookie(res, COOKIE_NAME, result.token, cookieOptions());
    return sendJson(res, 200, { success: true, user: { ...result.user, ...access, role: access.roles[0] || null } });
  } catch (err) {
    await auditService.record({ action: 'LOGIN_FAILED', resourceType: 'SESSION', result: err.statusCode === 403 ? 'DENIED' : 'FAILURE', metadata: { username: body && body.username }, ...requestMetadata(req) });
    return handleAuthError(res, err, 'login error');
  }
}

async function logout(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  try { if (token) await sessionStore.destroySession(token); } catch (err) { console.error('[auth] logout revocation error', err); }
  clearCookie(res, COOKIE_NAME, cookieOptions());
  await auditService.record({ actorUserId: req.session && req.session.userId, action: 'LOGOUT', resourceType: 'SESSION', result: 'SUCCESS', ...requestMetadata(req) });
  return sendJson(res, 200, { success: true });
}

async function me(req, res) {
  if (!req.session) return sendError(res, 401, 'Not authenticated.');
  const access = await authorizationService.getAccessProfile(req.session.userId);
  sendJson(res, 200, {
    success: true,
    user: {
      username: req.session.username,
      fullName: req.session.fullName,
      employeeId: req.session.employeeId,
      role: access.roles[0] || null,
      roles: access.roles,
      permissions: access.permissions,
      mustChangePassword: req.session.mustChangePassword
    }
  });
}

async function changePassword(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    const result = await authService.changePassword({ session: req.session, ...body, ...requestMetadata(req) });
    const access = await authorizationService.getAccessProfile(result.user.userId);
    setCookie(res, COOKIE_NAME, result.token, cookieOptions());
    return sendJson(res, 200, { success: true, user: { ...result.user, ...access, role: access.roles[0] || null } });
  } catch (err) {
    return handleAuthError(res, err, 'password change error');
  }
}

async function requestPasswordReset(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try { await authService.requestPasswordReset({ ...body, ...requestMetadata(req) }); }
  catch (err) { console.error('[auth] reset request error', err); }
  return sendJson(res, 202, { success: true, message: 'If the account can be recovered, reset instructions will be sent.' });
}

async function resetPassword(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    await authService.resetPassword(body);
    clearCookie(res, COOKIE_NAME, cookieOptions());
    return sendJson(res, 200, { success: true });
  } catch (err) {
    return handleAuthError(res, err, 'password reset error');
  }
}

async function authenticateRequest(req) {
  const session = await sessionStore.getSession(parseCookies(req)[COOKIE_NAME]);
  if (session) req.session = session;
  return session;
}

async function requireAuth(req, res, options = {}) {
  let session;
  try { session = req.session || await authenticateRequest(req); } catch (err) {
    console.error('[auth] session lookup error', err);
    sendError(res, 503, 'Authentication service is unavailable.', 'AUTH_SERVICE_ERROR');
    return false;
  }
  if (!session) {
    clearCookie(res, COOKIE_NAME, cookieOptions());
    sendError(res, 401, 'Not authenticated. Please log in.', 'AUTH_REQUIRED');
    return false;
  }
  if (session.mustChangePassword && !options.allowPasswordChange) {
    sendError(res, 403, 'Password change is required before continuing.', 'PASSWORD_CHANGE_REQUIRED');
    return false;
  }
  return true;
}

module.exports = {
  login, logout, me, changePassword, requestPasswordReset, resetPassword,
  authenticateRequest, requireAuth, COOKIE_NAME
};
