const db = require('../db');

async function create(conn, preview) {
  const result = await conn.execute(
    `INSERT INTO payroll_imports
      (preview_token_hash, created_by, pay_month, pay_year, source_file, file_size,
       file_sha256, mime_type, status, rows_payload, summary_payload,
       require_all_employees, expires_at)
     VALUES
      (:tokenHash, :createdBy, :payMonth, :payYear, :sourceFile, :fileSize,
       :fileSha256, :mimeType, 'PENDING', :rowsPayload, :summaryPayload,
       :requireAllEmployees, LOCALTIMESTAMP + NUMTODSINTERVAL(:ttlMinutes, 'MINUTE'))
     RETURNING import_id INTO :newId`,
    {
      tokenHash: preview.tokenHash,
      createdBy: preview.createdBy,
      payMonth: preview.payMonth,
      payYear: preview.payYear,
      sourceFile: preview.sourceFile,
      fileSize: preview.fileSize,
      fileSha256: preview.fileSha256,
      mimeType: preview.mimeType,
      rowsPayload: { val: JSON.stringify(preview.rows), type: db.oracledb.CLOB },
      summaryPayload: { val: JSON.stringify(preview.summary), type: db.oracledb.CLOB },
      requireAllEmployees: preview.requireAllEmployees ? 1 : 0,
      ttlMinutes: preview.ttlMinutes,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }
  );
  return result.outBinds.newId[0];
}

async function findForConfirmation(conn, tokenHash, userId) {
  const result = await conn.execute(
    `SELECT import_id, created_by, pay_month, pay_year, source_file, file_sha256, status,
            rows_payload, summary_payload, require_all_employees, expires_at, run_id,
            CASE WHEN expires_at <= LOCALTIMESTAMP THEN 1 ELSE 0 END AS is_expired
       FROM payroll_imports
      WHERE preview_token_hash = :tokenHash AND created_by = :userId
      FOR UPDATE`,
    { tokenHash, userId }
  );
  return result.rows[0] || null;
}

async function findByFileHash(conn, fileSha256, payMonth, payYear) {
  const result = await conn.execute(
    `SELECT import_id, run_id, source_file, status, file_sha256
       FROM payroll_imports
      WHERE file_sha256 = :fileSha256
        AND pay_month = :payMonth AND pay_year = :payYear
        AND status <> 'DELETED'
      ORDER BY created_at DESC`,
    { fileSha256, payMonth, payYear }
  );
  return result.rows;
}

async function markExpired(conn, importId) {
  await conn.execute(
    `UPDATE payroll_imports
        SET status = 'EXPIRED', rows_payload = '[]', updated_at = SYSTIMESTAMP
      WHERE import_id = :importId AND status IN ('PENDING', 'FAILED')`,
    { importId }
  );
}

async function markImported(conn, importId, runId) {
  await conn.execute(
    `UPDATE payroll_imports
        SET status = 'IMPORTED', run_id = :runId, rows_payload = '[]', confirmed_at = SYSTIMESTAMP,
            updated_at = SYSTIMESTAMP, error_message = NULL
      WHERE import_id = :importId`,
    { importId, runId }
  );
}

async function expireStale(conn) {
  return conn.execute(
    `UPDATE payroll_imports
        SET status = 'EXPIRED', rows_payload = '[]', updated_at = SYSTIMESTAMP
      WHERE status IN ('PENDING', 'FAILED') AND expires_at <= LOCALTIMESTAMP`
  );
}

async function markFailed(conn, importId, message) {
  await conn.execute(
    `UPDATE payroll_imports
        SET status = 'FAILED', error_message = :message, updated_at = SYSTIMESTAMP
      WHERE import_id = :importId`,
    { importId, message: String(message || 'Import failed.').slice(0, 500) }
  );
}

async function list(conn) {
  const result = await conn.execute(
    `SELECT i.import_id, i.run_id, i.pay_month, i.pay_year, i.source_file,
            i.file_size, i.status, i.confirmed_at, i.created_at,
            NVL(COUNT(p.payroll_id), 0) AS payroll_rows,
            r.status AS run_status
       FROM payroll_imports i
       LEFT JOIN payroll p ON p.import_id = i.import_id
       LEFT JOIN payroll_runs r ON r.run_id = i.run_id
      WHERE i.status <> 'DELETED'
      GROUP BY i.import_id, i.run_id, i.pay_month, i.pay_year, i.source_file,
               i.file_size, i.status, i.confirmed_at, i.created_at, r.status
      HAVING NVL(r.status, i.status) <> 'FINALIZED'
         AND SUM(CASE WHEN p.approval_status = 'FINALIZED' THEN 1 ELSE 0 END) = 0
      ORDER BY i.created_at DESC`
  );
  return result.rows;
}

async function findForDeletion(conn, importId) {
  const result = await conn.execute(
    `SELECT i.import_id, i.run_id, i.status, i.source_file, i.pay_month, i.pay_year,
            (SELECT r.status FROM payroll_runs r WHERE r.run_id = i.run_id) AS run_status
       FROM payroll_imports i
      WHERE i.import_id = :importId
      FOR UPDATE`,
    { importId }
  );
  return result.rows[0] || null;
}

async function deleteUploadBatch(conn, importId) {
  await conn.execute('DELETE FROM upload_batches WHERE import_id = :importId', { importId });
}

async function markDeleted(conn, importId) {
  await conn.execute(
    `UPDATE payroll_imports
        SET status = 'DELETED', run_id = NULL, rows_payload = '[]',
            summary_payload = '{}', error_message = NULL, updated_at = SYSTIMESTAMP
      WHERE import_id = :importId`,
    { importId }
  );
}

async function markDuplicatesDeleted(conn, importIds) {
  for (const importId of importIds) {
    await deleteUploadBatch(conn, importId);
    await markDeleted(conn, importId);
  }
}

module.exports = {
  create, findForConfirmation, findByFileHash, markExpired, markImported, markFailed, expireStale,
  list, findForDeletion, deleteUploadBatch, markDeleted, markDuplicatesDeleted
};
