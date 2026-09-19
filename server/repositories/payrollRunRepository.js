const db = require('../db');

async function create(conn, { payMonth, payYear, sourceFile, actorUserId, importId }) {
  const result = await conn.execute(
    `INSERT INTO payroll_runs
      (pay_month, pay_year, status, source_file, created_by, import_id)
     VALUES (:payMonth, :payYear, 'DRAFT', :sourceFile, :actorUserId, :importId)
     RETURNING run_id INTO :newId`,
    {
      payMonth,
      payYear,
      sourceFile,
      actorUserId: actorUserId || null,
      importId: importId || null,
      newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER }
    }
  );
  return result.outBinds.newId[0];
}

async function findByImportId(conn, importId) {
  const result = await conn.execute(
    `SELECT run_id, pay_month, pay_year, status, source_file, total_rows, validated_rows
       FROM payroll_runs WHERE import_id = :importId`,
    { importId }
  );
  return result.rows[0] || null;
}

async function findByPeriod(conn, payMonth, payYear, forUpdate = false) {
  const result = await conn.execute(
    `SELECT run_id, pay_month, pay_year, status, source_file, total_rows,
            validated_rows, error_message, version_no
       FROM payroll_runs
      WHERE pay_month = :payMonth AND pay_year = :payYear${forUpdate ? ' FOR UPDATE' : ''}`,
    { payMonth, payYear }
  );
  return result.rows[0] || null;
}

async function getById(conn, runId, forUpdate = false) {
  const result = await conn.execute(
    `SELECT run_id, pay_month, pay_year, status, source_file, total_rows,
            validated_rows, error_message, version_no, approved_by, approved_at,
            finalized_by, finalized_at
       FROM payroll_runs WHERE run_id = :runId${forUpdate ? ' FOR UPDATE' : ''}`,
    { runId }
  );
  return result.rows[0] || null;
}

async function updateState(conn, runId, fromState, toState, values = {}) {
  const assignments = [
    'status = :toState',
    'error_message = :errorMessage',
    'version_no = version_no + 1',
    'updated_at = SYSTIMESTAMP'
  ];
  const binds = {
    runId,
    fromState,
    toState,
    errorMessage: values.errorMessage || null
  };
  if (values.totalRows != null) {
    assignments.push('total_rows = :totalRows');
    binds.totalRows = values.totalRows;
  }
  if (values.validatedRows != null) {
    assignments.push('validated_rows = :validatedRows');
    binds.validatedRows = values.validatedRows;
  }
  if (values.approvedBy != null) {
    assignments.push('approved_by = :approvedBy', 'approved_at = SYSTIMESTAMP');
    binds.approvedBy = values.approvedBy;
  }
  if (values.finalizedBy != null) {
    assignments.push('finalized_by = :finalizedBy', 'finalized_at = SYSTIMESTAMP');
    binds.finalizedBy = values.finalizedBy;
  }
  const result = await conn.execute(
    `UPDATE payroll_runs
        SET ${assignments.join(', ')}
      WHERE run_id = :runId AND status = :fromState`,
    binds
  );
  return result.rowsAffected;
}

async function restartFailed(conn, runId, sourceFile, importId = null) {
  const result = await conn.execute(
    `UPDATE payroll_runs
        SET status = 'PROCESSING', source_file = :sourceFile,
            import_id = :importId,
            total_rows = 0, validated_rows = 0, error_message = NULL,
            version_no = version_no + 1, updated_at = SYSTIMESTAMP
      WHERE run_id = :runId AND status = 'FAILED'`,
    { runId, sourceFile, importId }
  );
  return result.rowsAffected;
}

async function updateCounts(conn, runId, count) {
  await conn.execute(
    `UPDATE payroll_runs
        SET total_rows = :count, validated_rows = :count,
            version_no = version_no + 1, updated_at = SYSTIMESTAMP
      WHERE run_id = :runId`,
    { runId, count }
  );
}

async function markEmptyAfterImportDeletion(conn, runId) {
  await conn.execute(
    `UPDATE payroll_runs
        SET status = 'FAILED', total_rows = 0, validated_rows = 0,
            error_message = 'All imported payroll data was removed.',
            import_id = NULL, version_no = version_no + 1, updated_at = SYSTIMESTAMP
      WHERE run_id = :runId`,
    { runId }
  );
}

async function resetAfterImportDeletion(conn, runId, remainingRows) {
  await conn.execute(
    `UPDATE payroll_runs
        SET status = :status, total_rows = :rowCount, validated_rows = :rowCount,
            approved_by = NULL, approved_at = NULL, finalized_by = NULL, finalized_at = NULL,
            error_message = :errorMessage, version_no = version_no + 1, updated_at = SYSTIMESTAMP
      WHERE run_id = :runId`,
    {
      runId,
      status: remainingRows ? 'VALIDATED' : 'FAILED',
      rowCount: remainingRows,
      errorMessage: 'Payroll changed because an uploaded source file was deleted.'
    }
  );
}

module.exports = {
  create, findByPeriod, findByImportId, getById, updateState, restartFailed,
  updateCounts, markEmptyAfterImportDeletion, resetAfterImportDeletion
};
