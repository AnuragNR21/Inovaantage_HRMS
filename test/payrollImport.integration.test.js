const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const db = require('../server/db');
const payrollImportService = require('../server/services/payrollImportService');
const { validateExcelFile } = require('../server/services/payrollFileSecurityService');
const { parseSalaryExcel } = require('../server/utils/excelParser');

const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const sourcePrefix = `import-test-${suffix}`;
const employeeCodeA = `I5A${String(Date.now()).slice(-8)}`;
const employeeCodeB = `I5B${String(Date.now()).slice(-8)}`;
let employeeIdA;
let employeeIdB;
let userIdA;
let userIdB;

const fileConfig = {
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 10000,
  maxColumns: 100,
  maxSheets: 10,
  diagnosticLimit: 100
};

function workbookBuffer(rows, headers = ['Employee Code', 'Employee Name', 'Basic Salary', 'PF', 'Net Salary']) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Salary');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function file(buffer, name = `${sourcePrefix}.xlsx`, mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
  return { buffer, originalFilename: name, mimeType, size: buffer.length };
}

function previewInput(payMonth, rows, overrides = {}) {
  const buffer = workbookBuffer(rows);
  return {
    payMonth,
    payYear: 2093,
    requireAllEmployees: false,
    file: file(buffer, `${sourcePrefix}-${payMonth}.xlsx`),
    actorUserId: userIdA,
    actorUsername: `import_a_${suffix}`,
    ...overrides
  };
}

test.before(async () => {
  await db.initPool();
  await db.withConnection(async (conn) => {
    const employeeA = await conn.execute(
      `INSERT INTO employees (employee_code, full_name, status)
       VALUES (:code, 'Import Test A', 'ACTIVE') RETURNING employee_id INTO :newId`,
      { code: employeeCodeA, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    const employeeB = await conn.execute(
      `INSERT INTO employees (employee_code, full_name, status)
       VALUES (:code, 'Import Test B', 'ACTIVE') RETURNING employee_id INTO :newId`,
      { code: employeeCodeB, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    employeeIdA = employeeA.outBinds.newId[0];
    employeeIdB = employeeB.outBinds.newId[0];
    const userA = await conn.execute(
      `INSERT INTO app_users (username, password_hash, full_name, role, is_active, must_change_password)
       VALUES (:username, 'not-used', 'Import User A', 'ADMIN', 1, 0)
       RETURNING user_id INTO :newId`,
      { username: `import_a_${suffix}`, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    const userB = await conn.execute(
      `INSERT INTO app_users (username, password_hash, full_name, role, is_active, must_change_password)
       VALUES (:username, 'not-used', 'Import User B', 'ADMIN', 1, 0)
       RETURNING user_id INTO :newId`,
      { username: `import_b_${suffix}`, newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }
    );
    userIdA = userA.outBinds.newId[0];
    userIdB = userB.outBinds.newId[0];
    await conn.commit();
  });
});

test.after(async () => {
  await db.withConnection(async (conn) => {
    const imports = await conn.execute(
      `SELECT import_id, run_id FROM payroll_imports WHERE source_file LIKE :prefix`,
      { prefix: `${sourcePrefix}%` }
    );
    const runIds = imports.rows.map((row) => row.RUN_ID).filter(Boolean);
    await conn.execute(`UPDATE payroll_imports SET run_id = NULL WHERE source_file LIKE :prefix`, { prefix: `${sourcePrefix}%` });
    for (const runId of runIds) {
      await conn.execute(`DELETE FROM upload_batches WHERE run_id = :runId`, { runId });
      await conn.execute(`DELETE FROM payroll_run_events WHERE run_id = :runId`, { runId });
      await conn.execute(`DELETE FROM payroll WHERE run_id = :runId`, { runId });
      await conn.execute(`DELETE FROM payroll_runs WHERE run_id = :runId`, { runId });
    }
    await conn.execute(`DELETE FROM payroll_imports WHERE source_file LIKE :prefix`, { prefix: `${sourcePrefix}%` });
    await conn.execute(`DELETE FROM app_users WHERE user_id IN (:userIdA, :userIdB)`, { userIdA, userIdB });
    await conn.execute(`DELETE FROM employees WHERE employee_id IN (:employeeIdA, :employeeIdB)`, { employeeIdA, employeeIdB });
    await conn.commit();
  });
  await db.closePool();
});

test('file security rejects spoofed extensions, legacy files, MIME mismatches, and oversized content', () => {
  const malicious = Buffer.from('MZ executable content');
  assert.throws(
    () => validateExcelFile(file(malicious), fileConfig),
    (err) => err.code === 'PAYROLL_FILE_SIGNATURE_INVALID'
  );
  const fakeZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.throws(
    () => validateExcelFile(file(fakeZip), fileConfig),
    (err) => err.code === 'PAYROLL_FILE_CONTAINER_INVALID'
  );
  const valid = workbookBuffer([[employeeCodeA, 'Import Test A', 1000, 0, 1000]]);
  assert.throws(
    () => validateExcelFile(file(valid, 'salary.xls'), fileConfig),
    (err) => err.code === 'PAYROLL_FILE_TYPE_INVALID'
  );
  assert.throws(
    () => validateExcelFile(file(valid, 'salary.xlsx', 'text/html'), fileConfig),
    (err) => err.code === 'PAYROLL_FILE_TYPE_INVALID'
  );
  assert.throws(
    () => validateExcelFile({ ...file(valid), size: 1000 }, { ...fileConfig, maxFileBytes: 100 }),
    (err) => err.code === 'PAYROLL_FILE_TOO_LARGE'
  );
});

test('schema parser rejects missing columns, malformed salary values, dates, and excessive dimensions', () => {
  assert.throws(
    () => parseSalaryExcel(workbookBuffer([['anything']], ['Unrelated']), fileConfig),
    (err) => err.code === 'PAYROLL_SCHEMA_INVALID'
  );
  const malformed = parseSalaryExcel(workbookBuffer([
    [employeeCodeA, 'Import Test A', '12oops', 0, 1000],
    [employeeCodeB, 'Import Test B', new Date('2026-01-01'), 0, 1000]
  ]), fileConfig);
  assert.equal(malformed.invalidRows, 2);
  assert.match(malformed.rowErrors[0].errors.join(' '), /invalid salary value/);
  assert.match(malformed.rowErrors[1].errors.join(' '), /not a date/);

  const oversized = workbookBuffer([[employeeCodeA, 'Import Test A', 1000, 0, 1000]]);
  assert.throws(
    () => parseSalaryExcel(oversized, { ...fileConfig, maxColumns: 4 }),
    (err) => err.code === 'PAYROLL_WORKBOOK_LIMIT_EXCEEDED'
  );
});

test('preview reports invalid, duplicate, unknown, and missing employees without persisting payroll', async () => {
  const result = await payrollImportService.preview(previewInput(1, [
    [employeeCodeA, 'Import Test A', 50000, 1000, 49000],
    [employeeCodeA, 'Import Test A', 50000, 1000, 49000],
    ['UNKNOWN-P5', 'Unknown Person', 50000, 1000, 49000],
    [employeeCodeB, 'Import Test B', 'bad-value', 1000, 49000]
  ], { requireAllEmployees: true }));
  assert.equal(result.readyForImport, false);
  assert.equal(result.summary.totalRows, 4);
  assert.equal(result.summary.validRows, 1);
  assert.equal(result.summary.invalidRows, 3);
  assert.equal(result.summary.duplicateRows, 1);
  assert.equal(result.summary.unknownEmployees, 1);
  assert.ok(result.summary.missingEmployees >= 1);
  assert.equal(result.previewToken, undefined);
  const persisted = await db.execute(`SELECT COUNT(*) AS cnt FROM payroll WHERE pay_month = 1 AND pay_year = 2093`);
  assert.equal(persisted.rows[0].CNT, 0);
});

test('confirmation is owner-bound, transactional, and idempotent', async () => {
  const preview = await payrollImportService.preview(previewInput(2, [
    [employeeCodeA, 'Import Test A', 50000, 1000, 49000],
    [employeeCodeB, 'Import Test B', 60000, 1200, 58800]
  ]));
  assert.equal(preview.readyForImport, true);
  assert.equal(preview.summary.validRows, 2);
  const before = await db.execute(`SELECT COUNT(*) AS cnt FROM payroll WHERE pay_month = 2 AND pay_year = 2093`);
  assert.equal(before.rows[0].CNT, 0);

  await assert.rejects(
    payrollImportService.confirm(preview.previewToken, { userId: userIdB, username: `import_b_${suffix}` }),
    (err) => err.statusCode === 404 && err.code === 'PAYROLL_PREVIEW_NOT_FOUND'
  );
  const imported = await payrollImportService.confirm(preview.previewToken, {
    userId: userIdA,
    username: `import_a_${suffix}`
  });
  assert.equal(imported.status, 'VALIDATED');
  assert.equal(imported.rows, 2);
  const after = await db.execute(
    `SELECT COUNT(*) AS cnt, COUNT(DISTINCT run_id) AS runs FROM payroll WHERE pay_month = 2 AND pay_year = 2093`
  );
  assert.equal(after.rows[0].CNT, 2);
  assert.equal(after.rows[0].RUNS, 1);

  const repeated = await payrollImportService.confirm(preview.previewToken, {
    userId: userIdA,
    username: `import_a_${suffix}`
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.runId, imported.runId);
  const unchanged = await db.execute(`SELECT COUNT(*) AS cnt FROM payroll WHERE pay_month = 2 AND pay_year = 2093`);
  assert.equal(unchanged.rows[0].CNT, 2);
});

test('same-period conflicts require a decision and expired previews cannot be confirmed', async () => {
  const duplicate = await payrollImportService.preview(previewInput(2, [[employeeCodeA, 'Import Test A', 50000, 1000, 49000]]));
  assert.equal(duplicate.readyForImport, true);
  assert.equal(duplicate.requiresResolution, true);
  assert.equal(duplicate.conflicts.length, 1);
  await assert.rejects(
    payrollImportService.confirm(duplicate.previewToken, { userId: userIdA, username: `import_a_${suffix}` }),
    (err) => err.statusCode === 422 && err.code === 'PAYROLL_DUPLICATE_RESOLUTION_REQUIRED'
  );
  const preview = await payrollImportService.preview(previewInput(3, [
    [employeeCodeA, 'Import Test A', 50000, 1000, 49000]
  ]));
  await db.execute(
    `UPDATE payroll_imports SET expires_at = LOCALTIMESTAMP - INTERVAL '1' MINUTE WHERE import_id = :importId`,
    { importId: preview.importId }, {}, true
  );
  await assert.rejects(
    payrollImportService.confirm(preview.previewToken, { userId: userIdA, username: `import_a_${suffix}` }),
    (err) => err.statusCode === 410 && err.code === 'PAYROLL_PREVIEW_EXPIRED'
  );
  const persisted = await db.execute(`SELECT COUNT(*) AS cnt FROM payroll WHERE pay_month = 3 AND pay_year = 2093`);
  assert.equal(persisted.rows[0].CNT, 0);
});

test('parser handles a practical 5,000-row workbook within configured limits', () => {
  const rows = Array.from({ length: 5000 }, (_, index) => [`LOAD-${index}`, `Employee ${index}`, 1000, 0, 1000]);
  const parsed = parseSalaryExcel(workbookBuffer(rows), fileConfig);
  assert.equal(parsed.totalRows, 5000);
  assert.equal(parsed.rows.length, 5000);
  assert.equal(parsed.invalidRows, 0);
});
