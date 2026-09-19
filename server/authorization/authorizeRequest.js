const authorizationService = require('../services/authorizationService');
const { permissionsForRequest } = require('./routePolicies');
const { sendError } = require('../utils/http');
const auditService = require('../services/auditService');

async function authorizeRequest(req, res, method, pathname) {
  const required = permissionsForRequest(method, pathname);
  if (!required) {
    console.error(`[authorization] no policy registered for ${method} ${pathname}`);
    await auditService.record({ actorUserId: req.session && req.session.userId, action: 'AUTHORIZATION_DENIED', resourceType: 'API', resourceId: pathname, result: 'DENIED', metadata: { method, reason: 'POLICY_MISSING' } });
    sendError(res, 403, 'Access to this resource is not permitted.', 'AUTHORIZATION_POLICY_MISSING');
    return false;
  }
  try {
    const decision = await authorizationService.authorize(req.session.userId, required);
    req.authorization = decision.profile;
    if (decision.allowed && decision.scope === 'SELF' && !req.session.employeeId) {
      sendError(res, 403, 'Your portal account is not linked to an employee record.', 'EMPLOYEE_LINK_REQUIRED');
      return false;
    }
    if (decision.allowed) {
      req.dataScope = Object.freeze({
        type: decision.scope,
        employeeId: decision.scope === 'SELF' ? req.session.employeeId : null
      });
      return true;
    }
    await auditService.record({ actorUserId: req.session.userId, action: 'AUTHORIZATION_DENIED', resourceType: 'API', resourceId: pathname, result: 'DENIED', metadata: { method, required } });
    sendError(res, 403, 'You do not have permission to perform this action.', 'FORBIDDEN');
    return false;
  } catch (err) {
    console.error('[authorization] policy evaluation failed', err);
    sendError(res, 503, 'Authorization service is unavailable.', 'AUTHORIZATION_SERVICE_ERROR');
    return false;
  }
}

module.exports = { authorizeRequest };
