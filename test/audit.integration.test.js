const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auditRepository = require('../server/repositories/auditRepository');
const { safeMetadata } = require('../server/services/auditService');

const action = `TEST_AUDIT_${Date.now()}`;

test.before(async () => { await db.initPool(); });

test.after(async () => { await db.closePool(); });

test('sensitive audit entries persist safe metadata without credentials or documents', async () => {
  await db.withConnection(async (conn) => {
    await auditRepository.record(conn, {
      action,
      resourceType: 'PAYSLIP',
      resourceId: 'test-resource',
      result: 'SUCCESS',
      metadata: safeMetadata({ payrollId: 42, password: 'redacted', documentContent: 'pdf-bytes' })
    });
    const result = await conn.execute(
      'SELECT action, resource_type, resource_id, result, metadata FROM audit_logs WHERE action = :action',
      { action }
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].ACTION, action);
    assert.equal(result.rows[0].RESOURCE_TYPE, 'PAYSLIP');
    assert.equal(result.rows[0].RESULT, 'SUCCESS');
    assert.deepEqual(JSON.parse(result.rows[0].METADATA), { payrollId: 42 });
    await conn.rollback();
  });
});
