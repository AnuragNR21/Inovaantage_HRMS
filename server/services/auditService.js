const db = require('../db');
const defaultRepository = require('../repositories/auditRepository');

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const blocked = /password|token|secret|credential|authorization|content|document|pdf|buffer/i;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !blocked.test(key)));
}

function createAuditService(dependencies = {}) {
  const database = dependencies.db || db;
  const repository = dependencies.repository || defaultRepository;
  const logger = dependencies.logger || console;

  async function record(event) {
    try {
      await database.withConnection(async (conn) => {
        await repository.record(conn, { ...event, metadata: safeMetadata(event.metadata) });
        await conn.commit();
      });
    } catch (err) {
      logger.error('[audit] could not record event', err.message);
    }
  }

  async function list(filters) {
    return repository.list(filters);
  }

  return { record, list };
}

const auditService = createAuditService();
module.exports = auditService;
module.exports.createAuditService = createAuditService;
module.exports.safeMetadata = safeMetadata;
