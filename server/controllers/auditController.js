const { sendJson, sendError } = require('../utils/http');
const auditService = require('../services/auditService');

function createAuditController(dependencies = {}) {
  const service = dependencies.auditService || auditService;

  async function list(req, res, query) {
  try {
    const records = await service.list(query);
    return sendJson(res, 200, { success: true, records: records.map((row) => ({
      auditId: row.AUDIT_ID,
      actorUserId: row.ACTOR_USER_ID,
      action: row.ACTION,
      resourceType: row.RESOURCE_TYPE,
      resourceId: row.RESOURCE_ID,
      result: row.RESULT,
      ipAddress: row.IP_ADDRESS,
      userAgent: row.USER_AGENT,
      metadata: (() => { try { return row.METADATA ? JSON.parse(row.METADATA) : null; } catch (_) { return null; } })(),
      createdAt: row.CREATED_AT
    })) });
  } catch (err) {
    console.error('[audit] query error', err);
    return sendError(res, 500, 'Failed to fetch audit records.', 'AUDIT_QUERY_FAILED');
  }
}

  return { list };
}

module.exports = createAuditController();
module.exports.createAuditController = createAuditController;
