const fs = require('fs');
const os = require('os');
const formidable = require('formidable');
const { sendJson, sendError, readJsonBody } = require('../utils/http');
const payrollImportService = require('../services/payrollImportService');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const { getPayrollImportConfig } = require('../config');
const auditService = require('../services/auditService');

function parseMultipart(req, maxFileBytes) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFiles: 1,
      maxFileSize: maxFileBytes,
      maxTotalFileSize: maxFileBytes,
      allowEmptyFiles: false,
      minFileSize: 1,
      uploadDir: os.tmpdir(),
      keepExtensions: false
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function fieldValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function booleanField(value, fallback = true) {
  const normalized = String(fieldValue(value) == null ? '' : fieldValue(value)).toLowerCase();
  if (!normalized) return fallback;
  return ['true', '1', 'on', 'yes'].includes(normalized);
}

function handleError(res, err, context) {
  if (err instanceof PayrollDomainError) {
    return sendJson(res, err.statusCode, {
      success: false,
      message: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {})
    });
  }
  console.error(`[salary] ${context}`, err);
  return sendError(res, 500, 'Salary import failed without changing payroll records.', 'PAYROLL_IMPORT_FAILED');
}

async function previewSalary(req, res) {
  const config = getPayrollImportConfig();
  let fields;
  let files;
  try {
    ({ fields, files } = await parseMultipart(req, config.maxFileBytes));
  } catch (err) {
    const tooLarge = err && (err.code === 1009 || /maxFileSize|maxTotalFileSize|too large/i.test(err.message || ''));
    return sendError(
      res,
      tooLarge ? 413 : 400,
      tooLarge ? `The Excel file must not exceed ${Math.floor(config.maxFileBytes / 1024 / 1024)} MB.` : 'Failed to read the uploaded file.',
      tooLarge ? 'PAYROLL_FILE_TOO_LARGE' : 'PAYROLL_UPLOAD_INVALID'
    );
  }

  const file = files.file && (Array.isArray(files.file) ? files.file[0] : files.file);
  if (!file) return sendError(res, 400, 'Attach one .xlsx salary workbook as "file".', 'PAYROLL_FILE_REQUIRED');
  const filepath = file.filepath || file.path;
  try {
    const buffer = await fs.promises.readFile(filepath);
    const result = await payrollImportService.preview({
      payMonth: fieldValue(fields.payMonth),
      payYear: fieldValue(fields.payYear),
      requireAllEmployees: booleanField(fields.requireAllEmployees),
      file: {
        buffer,
        originalFilename: file.originalFilename,
        mimeType: file.mimetype,
        size: file.size
      },
      actorUserId: req.session.userId,
      actorUsername: req.session.username
    });
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYROLL_UPLOAD', resourceType: 'PAYROLL_IMPORT', resourceId: result.runId || null, metadata: { stage: 'PREVIEW', payMonth: fieldValue(fields.payMonth), payYear: fieldValue(fields.payYear), fileName: file.originalFilename, fileSize: file.size } });
    return sendJson(res, 200, result);
  } catch (err) {
    return handleError(res, err, 'preview failed');
  } finally {
    try { await fs.promises.unlink(filepath); } catch (err) { /* best-effort temporary-file cleanup */ }
  }
}

async function confirmSalary(req, res) {
  try {
    const body = await readJsonBody(req);
    const result = await payrollImportService.confirm(body.previewToken, {
      userId: req.session.userId,
      username: req.session.username
    }, body.resolutions || {}, body.duplicateFileDecision || '');
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYROLL_PROCESSING', resourceType: 'PAYROLL_RUN', resourceId: result.runId, metadata: { stage: 'CONFIRM', status: result.status, rows: result.rows, idempotent: Boolean(result.idempotent) } });
    return sendJson(res, result.idempotent ? 200 : 201, result);
  } catch (err) {
    if (err.message === 'Invalid JSON body' || err.message === 'Request body too large') {
      return sendError(res, 400, err.message, 'INVALID_REQUEST');
    }
    return handleError(res, err, 'confirmation failed');
  }
}

async function listImports(req, res) {
  try {
    const imports = await payrollImportService.listImports();
    return sendJson(res, 200, { success: true, imports });
  } catch (err) {
    return handleError(res, err, 'import listing failed');
  }
}

async function deleteImport(req, res, importId) {
  try {
    const result = await payrollImportService.deleteImport(importId, req.session.userId);
    await auditService.record({
      actorUserId: req.session.userId,
      action: 'PAYROLL_IMPORT_DELETED',
      resourceType: 'PAYROLL_IMPORT',
      resourceId: importId,
      metadata: { runId: result.runId, removedRows: result.removedRows, remainingRows: result.remainingRows }
    });
    return sendJson(res, 200, { success: true, ...result });
  } catch (err) {
    return handleError(res, err, 'import deletion failed');
  }
}

module.exports = { previewSalary, confirmSalary, listImports, deleteImport };
