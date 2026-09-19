const db = require('../db');

function metadataValue(value) {
  if (value == null) return null;
  try { return JSON.stringify(value).slice(0, 4000); } catch (_) { return null; }
}

async function record(connection, event) {
  const executor = connection || db;
  return executor.execute(
    `INSERT INTO audit_logs
      (actor_user_id, action, resource_type, resource_id, result,
       ip_address, user_agent, metadata)
     VALUES (:actorUserId, :action, :resourceType, :resourceId, :result,
             :ipAddress, :userAgent, :metadata)`,
    {
      actorUserId: event.actorUserId || null,
      action: String(event.action).slice(0, 80),
      resourceType: String(event.resourceType || 'SYSTEM').slice(0, 60),
      resourceId: event.resourceId == null ? null : String(event.resourceId).slice(0, 120),
      result: String(event.result || 'SUCCESS').slice(0, 20),
      ipAddress: event.ipAddress ? String(event.ipAddress).slice(0, 64) : null,
      userAgent: event.userAgent ? String(event.userAgent).slice(0, 500) : null,
      metadata: metadataValue(event.metadata)
    }
  );
}

async function list({ action, resourceType, actorUserId, result, from, to, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const binds = { limit: Math.min(Math.max(Number(limit) || 100, 1), 500), offset: Math.max(Number(offset) || 0, 0) };
  if (action) { conditions.push('action = :action'); binds.action = String(action).slice(0, 80); }
  if (resourceType) { conditions.push('resource_type = :resourceType'); binds.resourceType = String(resourceType).slice(0, 60); }
  if (actorUserId) { conditions.push('actor_user_id = :actorUserId'); binds.actorUserId = Number(actorUserId); }
  if (result) { conditions.push('result = :result'); binds.result = String(result).slice(0, 20); }
  if (from) { conditions.push('created_at >= TO_TIMESTAMP(:from, \'YYYY-MM-DD\')'); binds.from = String(from).slice(0, 10); }
  if (to) { conditions.push("created_at < TO_TIMESTAMP(:to, 'YYYY-MM-DD') + INTERVAL '1' DAY"); binds.to = String(to).slice(0, 10); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT audit_id, actor_user_id, action, resource_type, resource_id,
                        result, ip_address, user_agent, metadata, created_at
                   FROM audit_logs ${where}
                  ORDER BY audit_id DESC
                  OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY`;
  const resultSet = await db.execute(query, binds);
  return resultSet.rows;
}

module.exports = { record, list };
