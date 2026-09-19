const crypto = require('crypto');
const db = require('../db');
const importRepository = require('../repositories/payrollImportRepository');
const runRepository = require('../repositories/payrollRunRepository');
const payrollRepository = require('../repositories/payrollRepository');
const payrollProcessingService = require('./payrollProcessingService');
const { calculatePayrollRow } = require('./payrollCalculationService');
const { validateExcelFile } = require('./payrollFileSecurityService');
const { parseSalaryExcel } = require('../utils/excelParser');
const { getPayrollImportConfig } = require('../config');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function periodValue(value, name, min, max) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) {
    throw new PayrollDomainError(422, 'PAYROLL_PERIOD_INVALID', `${name} must be a whole number between ${min} and ${max}.`);
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PayrollDomainError(422, 'PAYROLL_PERIOD_INVALID', `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function identifier(row) {
  return String(row.employee_code || row.employee_name || '').trim();
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function previewRow(row) {
  const calculated = calculatePayrollRow(row);
  return {
    row: row.excel_row_number,
    employeeCode: row.employeeCode,
    employeeName: row.employee_name || '',
    totalEarnings: calculated.total_earnings,
    totalDeductions: calculated.total_deductions,
    netSalary: calculated.net_salary
  };
}

function conflictView(existing, uploaded) {
  const calculated = calculatePayrollRow(uploaded);
  return {
    employeeCode: uploaded.employeeCode,
    employeeName: uploaded.fullName,
    existing: {
      sourceFile: existing.SOURCE_FILE || '-',
      totalEarnings: Number(existing.TOTAL_EARNINGS) || 0,
      totalDeductions: Number(existing.TOTAL_DEDUCTIONS) || 0,
      netSalary: Number(existing.NET_SALARY) || 0
    },
    uploaded: {
      sourceFile: uploaded.sourceFile || '-',
      totalEarnings: calculated.total_earnings,
      totalDeductions: calculated.total_deductions,
      netSalary: calculated.net_salary
    }
  };
}

function duplicateFileView(existing, filename) {
  return {
    importId: Number(existing.IMPORT_ID),
    sourceFile: existing.SOURCE_FILE,
    status: existing.STATUS,
    runId: existing.RUN_ID || null,
    uploadedFile: filename
  };
}

function validateAgainstEmployees(parsed, employeeIndex, requireAllEmployees, diagnosticLimit) {
  const duplicates = [];
  const unknownEmployees = [];
  const rowErrors = [...parsed.rowErrors];
  const acceptedRows = [];
  const seenIdentifiers = new Set();
  const seenEmployeeIds = new Set();

  for (const row of parsed.rows) {
    const label = identifier(row);
    const identifierKey = `${row.employee_code ? 'code' : 'name'}:${label.toLowerCase()}`;
    if (seenIdentifiers.has(identifierKey)) {
      duplicates.push(label);
      if (rowErrors.length < diagnosticLimit) {
        rowErrors.push({ row: row.excel_row_number, identifier: label, errors: ['duplicate employee in workbook'] });
      }
      continue;
    }
    seenIdentifiers.add(identifierKey);
    const employee = payrollRepository.matchEmployee(employeeIndex, row);
    if (!employee) {
      unknownEmployees.push(label);
      if (rowErrors.length < diagnosticLimit) {
        rowErrors.push({ row: row.excel_row_number, identifier: label, errors: ['active employee was not found'] });
      }
      continue;
    }
    if (seenEmployeeIds.has(employee.employeeId)) {
      duplicates.push(label);
      if (rowErrors.length < diagnosticLimit) {
        rowErrors.push({ row: row.excel_row_number, identifier: label, errors: ['resolves to a duplicate employee'] });
      }
      continue;
    }
    if (row.employee_code && row.employee_name && normalizedName(row.employee_name) !== normalizedName(employee.fullName)) {
      parsed.warnings.push(`Row ${row.excel_row_number}: employee name does not match ${employee.employeeCode}; Employee Code was used.`);
    }
    seenEmployeeIds.add(employee.employeeId);
    acceptedRows.push({ ...row, ...employee });
  }

  const activeEmployees = [...employeeIndex.byCode.values()];
  const missingEmployees = activeEmployees
    .filter((employee) => !seenEmployeeIds.has(employee.employeeId))
    .map((employee) => employee.employeeCode);
  const warnings = [...parsed.warnings];
  if (missingEmployees.length && !requireAllEmployees) {
    warnings.push(`${missingEmployees.length} active employee(s) are not included in this payroll file.`);
  }
  const validRows = acceptedRows.length;
  const invalidRows = parsed.totalRows - validRows;
  return {
    rows: acceptedRows,
    summary: {
      totalRows: parsed.totalRows,
      validRows,
      invalidRows,
      duplicateRows: duplicates.length,
      unknownEmployees: unknownEmployees.length,
      missingEmployees: missingEmployees.length,
      duplicateIdentifiers: duplicates.slice(0, diagnosticLimit),
      unknownEmployeeIdentifiers: unknownEmployees.slice(0, diagnosticLimit),
      missingEmployeeIdentifiers: missingEmployees.slice(0, diagnosticLimit),
      warnings: warnings.slice(0, diagnosticLimit),
      errors: rowErrors.slice(0, diagnosticLimit),
      diagnosticsTruncated: rowErrors.length > diagnosticLimit || duplicates.length > diagnosticLimit ||
        unknownEmployees.length > diagnosticLimit || missingEmployees.length > diagnosticLimit
    },
    readyForImport: invalidRows === 0 && (!requireAllEmployees || missingEmployees.length === 0)
  };
}

function createPayrollImportService(dependencies = {}) {
  const database = dependencies.db || db;
  const imports = dependencies.importRepository || importRepository;
  const runs = dependencies.runRepository || runRepository;
  const payroll = dependencies.payrollRepository || payrollRepository;
  const processor = dependencies.payrollProcessingService || payrollProcessingService;
  const config = dependencies.config || getPayrollImportConfig();

  async function preview(input) {
    const payMonth = periodValue(input.payMonth, 'Pay month', 1, 12);
    const payYear = periodValue(input.payYear, 'Pay year', 2000, 2100);
    const requireAllEmployees = input.requireAllEmployees !== false;
    const file = validateExcelFile(input.file, config);
    const parsed = parseSalaryExcel(input.file.buffer, config);

    return database.withConnection(async (conn) => {
      try {
        await imports.expireStale(conn);
        const existing = await runs.findByPeriod(conn, payMonth, payYear);
        if (existing && [PAYROLL_STATES.DRAFT, PAYROLL_STATES.PROCESSING].includes(existing.STATUS)) {
          throw new PayrollDomainError(
            409,
            'PAYROLL_PERIOD_NOT_EDITABLE',
            `Payroll for ${payMonth}/${payYear} is currently ${existing.STATUS}. Try again after processing finishes.`
          );
        }
        const employeeIndex = await payroll.getEmployeeMatchIndex(conn);
        const validation = validateAgainstEmployees(parsed, employeeIndex, requireAllEmployees, config.diagnosticLimit);
        if (!validation.readyForImport) {
          await conn.rollback();
          return {
            success: true, stage: 'PREVIEW', readyForImport: false,
            file: { name: file.filename, size: file.size, sheetName: parsed.sheetName },
            period: { payMonth, payYear }, summary: validation.summary,
            rows: validation.rows.slice(0, config.previewRowLimit).map(previewRow)
          };
        }

        const duplicateFiles = (await imports.findByFileHash(conn, file.sha256, payMonth, payYear))
          .map((item) => duplicateFileView(item, file.filename));
        const existingRows = existing
          ? await payroll.findPeriodConflicts(conn, payMonth, payYear, validation.rows.map((row) => row.employeeId))
          : [];
        const existingByEmployee = new Map(existingRows.map((row) => [Number(row.EMPLOYEE_ID), row]));
        const conflicts = validation.rows
          .filter((row) => existingByEmployee.has(Number(row.employeeId)))
          .map((row) => conflictView(existingByEmployee.get(Number(row.employeeId)), { ...row, sourceFile: file.filename }));
        validation.summary.existingEmployeeConflicts = conflicts.length;
        validation.summary.duplicateFiles = duplicateFiles.length;

        const token = crypto.randomBytes(32).toString('base64url');
        const importId = await imports.create(conn, {
          tokenHash: tokenHash(token), createdBy: input.actorUserId, payMonth, payYear,
          sourceFile: file.filename, fileSize: file.size, fileSha256: file.sha256,
          mimeType: file.mimeType, rows: validation.rows, summary: validation.summary,
          requireAllEmployees, ttlMinutes: config.previewTtlMinutes
        });
        await conn.commit();
        return {
          success: true, stage: 'PREVIEW', readyForImport: true, previewToken: token, importId,
          expiresInMinutes: config.previewTtlMinutes,
          file: { name: file.filename, size: file.size, sheetName: parsed.sheetName },
          period: { payMonth, payYear }, summary: validation.summary, conflicts, duplicateFiles,
          requiresResolution: conflicts.length > 0 || duplicateFiles.length > 0,
          rows: validation.rows.slice(0, config.previewRowLimit).map(previewRow)
        };
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
  }

  async function confirm(previewToken, actor, resolutions = {}, duplicateFileDecision = '') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(previewToken || ''))) {
      throw new PayrollDomainError(404, 'PAYROLL_PREVIEW_NOT_FOUND', 'Payroll preview was not found or is no longer available.');
    }
    return database.withConnection(async (conn) => {
      let previewRecord;
      try {
        previewRecord = await imports.findForConfirmation(conn, tokenHash(previewToken), actor.userId);
        if (!previewRecord) {
          throw new PayrollDomainError(404, 'PAYROLL_PREVIEW_NOT_FOUND', 'Payroll preview was not found or is no longer available.');
        }
        if (previewRecord.STATUS === 'IMPORTED') {
          const importedRun = await runs.findByImportId(conn, previewRecord.IMPORT_ID);
          await conn.rollback();
          return {
            success: true,
            stage: 'IMPORTED',
            runId: previewRecord.RUN_ID,
            status: importedRun ? importedRun.STATUS : PAYROLL_STATES.VALIDATED,
            rows: importedRun ? importedRun.VALIDATED_ROWS : undefined,
            idempotent: true
          };
        }
        if (previewRecord.IS_EXPIRED === 1) {
          await imports.markExpired(conn, previewRecord.IMPORT_ID);
          await conn.commit();
          throw new PayrollDomainError(410, 'PAYROLL_PREVIEW_EXPIRED', 'Payroll preview has expired. Upload the file again.');
        }
        if (!['PENDING', 'FAILED'].includes(previewRecord.STATUS)) {
          throw new PayrollDomainError(409, 'PAYROLL_IMPORT_IN_PROGRESS', 'This payroll import is already being processed.');
        }

        const duplicateFiles = (await imports.findByFileHash(
          conn, previewRecord.FILE_SHA256, previewRecord.PAY_MONTH, previewRecord.PAY_YEAR
        )).filter((item) => Number(item.IMPORT_ID) !== Number(previewRecord.IMPORT_ID));
        if (duplicateFiles.length) {
          const fileDecision = String(duplicateFileDecision || '').toUpperCase();
          if (!['EXISTING', 'UPLOADED'].includes(fileDecision)) {
            throw new PayrollDomainError(422, 'PAYROLL_DUPLICATE_FILE_RESOLUTION_REQUIRED', 'Choose whether to keep the existing file or use the uploaded copy.');
          }
          if (fileDecision === 'EXISTING') {
            await imports.markDeleted(conn, previewRecord.IMPORT_ID);
            await conn.commit();
            return {
              success: true, stage: 'DUPLICATE_SKIPPED', runId: duplicateFiles[0].RUN_ID || null,
              status: 'KEPT_EXISTING', rows: 0, keptExistingFile: duplicateFiles[0].SOURCE_FILE
            };
          }
        }

        const recoveredRun = await runs.findByImportId(conn, previewRecord.IMPORT_ID);
        if (recoveredRun && recoveredRun.STATUS !== PAYROLL_STATES.FAILED) {
          await imports.markImported(conn, previewRecord.IMPORT_ID, recoveredRun.RUN_ID);
          await conn.commit();
          return {
            success: true, stage: 'IMPORTED', runId: recoveredRun.RUN_ID,
            status: recoveredRun.STATUS, rows: recoveredRun.VALIDATED_ROWS, idempotent: true
          };
        }

        const rows = JSON.parse(previewRecord.ROWS_PAYLOAD);
        const employeeIndex = await payroll.getEmployeeMatchIndex(conn);
        const revalidated = validateAgainstEmployees(
          { rows, rowErrors: [], warnings: [], totalRows: rows.length },
          employeeIndex,
          previewRecord.REQUIRE_ALL_EMPLOYEES === 1,
          config.diagnosticLimit
        );
        if (!revalidated.readyForImport) {
          await imports.markFailed(conn, previewRecord.IMPORT_ID, 'Employee data changed after preview validation.');
          await conn.commit();
          throw new PayrollDomainError(409, 'PAYROLL_PREVIEW_STALE', 'Employee data changed after preview. Upload and validate the file again.', revalidated.summary);
        }

        const currentRun = await runs.findByPeriod(conn, previewRecord.PAY_MONTH, previewRecord.PAY_YEAR);
        if (currentRun && [PAYROLL_STATES.DRAFT, PAYROLL_STATES.PROCESSING].includes(currentRun.STATUS)) {
          throw new PayrollDomainError(409, 'PAYROLL_PERIOD_NOT_EDITABLE', `Payroll is currently ${currentRun.STATUS}. Try again after processing finishes.`);
        }
        const conflicts = currentRun
          ? await payroll.findPeriodConflicts(
            conn, previewRecord.PAY_MONTH, previewRecord.PAY_YEAR,
            revalidated.rows.map((row) => row.employeeId)
          )
          : [];
        const conflictByEmployee = new Map(conflicts.map((row) => [Number(row.EMPLOYEE_ID), row]));
        const rowsToImport = [];
        const replacePayrollIds = [];
        for (const row of revalidated.rows) {
          const conflict = conflictByEmployee.get(Number(row.employeeId));
          if (!conflict) { rowsToImport.push(row); continue; }
          const decision = String(resolutions[row.employeeCode] || '').toUpperCase();
          if (!['EXISTING', 'UPLOADED'].includes(decision)) {
            throw new PayrollDomainError(422, 'PAYROLL_DUPLICATE_RESOLUTION_REQUIRED', `Choose which payroll data to keep for ${row.employeeCode}.`);
          }
          if (decision === 'UPLOADED') {
            rowsToImport.push(row);
            replacePayrollIds.push(conflict.PAYROLL_ID);
          }
        }
        if (!rowsToImport.length) {
          await imports.markDeleted(conn, previewRecord.IMPORT_ID);
          await conn.commit();
          return {
            success: true, stage: 'IMPORTED', runId: currentRun.RUN_ID,
            status: currentRun.STATUS, rows: 0, keptExisting: conflicts.length
          };
        }

        try {
          const result = await processor.process({
            importId: previewRecord.IMPORT_ID,
            payMonth: previewRecord.PAY_MONTH,
            payYear: previewRecord.PAY_YEAR,
            sourceFile: previewRecord.SOURCE_FILE,
            rows: rowsToImport,
            replacePayrollIds,
            parseWarnings: JSON.parse(previewRecord.SUMMARY_PAYLOAD).warnings || [],
            actorUserId: actor.userId,
            actorUsername: actor.username
          });
          await imports.markImported(conn, previewRecord.IMPORT_ID, result.runId);
          await conn.commit();
          return { success: true, stage: 'IMPORTED', ...result, summary: JSON.parse(previewRecord.SUMMARY_PAYLOAD) };
        } catch (err) {
          await imports.markFailed(conn, previewRecord.IMPORT_ID, err.message);
          await conn.commit();
          throw err;
        }
      } catch (err) {
        if (!previewRecord || !['FAILED', 'EXPIRED', 'IMPORTED'].includes(previewRecord.STATUS)) {
          try { await conn.rollback(); } catch (rollbackError) { /* original error wins */ }
        }
        throw err;
      }
    });
  }

  async function listImports() {
    return database.withConnection(async (conn) => {
      try {
        await imports.expireStale(conn);
        const records = await imports.list(conn);
        await conn.commit();
        return records;
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
  }

  async function deleteImport(importId, actorUserId) {
    if (!Number.isInteger(Number(importId)) || Number(importId) < 1) {
      throw new PayrollDomainError(400, 'PAYROLL_IMPORT_ID_INVALID', 'Payroll import ID is invalid.');
    }
    return database.withConnection(async (conn) => {
      try {
        const record = await imports.findForDeletion(conn, Number(importId));
        if (!record || record.STATUS === 'DELETED') {
          throw new PayrollDomainError(404, 'PAYROLL_IMPORT_NOT_FOUND', 'Uploaded payroll file was not found.');
        }
        if (record.STATUS !== 'IMPORTED') {
          await imports.markDeleted(conn, record.IMPORT_ID);
          await conn.commit();
          return { importId: record.IMPORT_ID, removedRows: 0, runId: null };
        }
        const run = await runs.getById(conn, record.RUN_ID, true);
        if (!run) throw new PayrollDomainError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run was not found.');
        // Source deletion invalidates payslips and email jobs for the monthly run.
        await payroll.deleteDeliveryArtifactsByRun(conn, record.RUN_ID);
        const removedRows = await payroll.deleteByImport(conn, record.IMPORT_ID);
        await imports.deleteUploadBatch(conn, record.IMPORT_ID);
        await imports.markDeleted(conn, record.IMPORT_ID);
        const remainingRows = await payroll.countByRun(conn, record.RUN_ID);
        await runs.resetAfterImportDeletion(conn, record.RUN_ID, remainingRows);
        await conn.execute(
          `INSERT INTO payroll_run_events
            (run_id, event_type, from_state, to_state, actor_user_id, details)
           VALUES (:runId, 'PAYROLL_IMPORT_DELETED', :fromState, :toState, :actorUserId, :details)`,
          {
            runId: record.RUN_ID, fromState: run.STATUS,
            toState: remainingRows ? PAYROLL_STATES.VALIDATED : PAYROLL_STATES.FAILED,
            actorUserId: actorUserId || null,
            details: JSON.stringify({ importId: record.IMPORT_ID, sourceFile: record.SOURCE_FILE, removedRows })
          }
        );
        await conn.commit();
        return { importId: record.IMPORT_ID, runId: record.RUN_ID, removedRows, remainingRows };
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
  }

  return { preview, confirm, listImports, deleteImport };
}

module.exports = createPayrollImportService();
module.exports.createPayrollImportService = createPayrollImportService;
module.exports.validateAgainstEmployees = validateAgainstEmployees;
