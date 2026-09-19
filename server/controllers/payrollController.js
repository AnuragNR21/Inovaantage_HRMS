const { sendJson, sendError } = require('../utils/http');
const payrollQueryService = require('../services/payrollQueryService');
const payrollRecordService = require('../services/payrollRecordService');
const payslipGenerationService = require('../services/payslipGenerationService');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const auditService = require('../services/auditService');
const { buildPayrollDetailCsv } = require('../utils/payrollCsvExport');

function handleDomainError(res, err, fallbackMessage) {
  if (err instanceof PayrollDomainError) return sendError(res, err.statusCode, err.message, err.code);
  console.error('[payroll] operation error', err);
  return sendError(res, 500, fallbackMessage, 'PAYROLL_OPERATION_FAILED');
}

async function listPayrollHistory(req, res, query) {
  try {
    const records = await payrollQueryService.listHistory(req, query);
    return sendJson(res, 200, { success: true, records });
  } catch (err) {
    return handleDomainError(res, err, 'Failed to fetch payroll history.');
  }
}

async function listPayslips(req, res, query) {
  try {
    const records = await payrollQueryService.listPayslips(req, query);
    return sendJson(res, 200, { success: true, records });
  } catch (err) {
    return handleDomainError(res, err, 'Failed to fetch payslips.');
  }
}

async function listPayrollReports(req, res) {
  try {
    return sendJson(res, 200, { success: true, reports: await payrollQueryService.listRunReports() });
  } catch (err) {
    return handleDomainError(res, err, 'Failed to fetch payroll reports.');
  }
}

async function exportPayrollReport(req, res, runId) {
  try {
    const report = await payrollQueryService.getRunDetailReport(runId);
    if (!report) throw new PayrollDomainError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found.');
    const csv = buildPayrollDetailCsv(report.records);
    const fileName = `payroll-details-${report.run.PAY_YEAR}-${String(report.run.PAY_MONTH).padStart(2, '0')}.csv`;
    await auditService.record({
      actorUserId: req.session.userId,
      action: 'PAYROLL_REPORT_EXPORTED',
      resourceType: 'PAYROLL_RUN',
      resourceId: runId,
      metadata: { format: 'CSV', rowCount: report.records.length }
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': Buffer.byteLength(csv),
      'Cache-Control': 'private, no-store'
    });
    return res.end(csv);
  } catch (err) {
    return handleDomainError(res, err, 'Failed to export payroll report.');
  }
}

async function downloadPayslip(req, res, payrollId) {
  try {
    const result = await payslipGenerationService.getDownload(req, payrollId);
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYSLIP_DOWNLOAD', resourceType: 'PAYROLL', resourceId: payrollId, metadata: { delivery: 'HTTP_DOWNLOAD' } });
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'Content-Length': result.content.length,
      'Cache-Control': 'private, no-store'
    });
    return res.end(result.content);
  } catch (err) {
    return handleDomainError(res, err, 'Failed to generate payslip PDF.');
  }
}

async function deletePayrollRecord(req, res, payrollId) {
  try {
    await payrollRecordService.deleteRecord(payrollId, req.session.userId);
    await auditService.record({ actorUserId: req.session.userId, action: 'SALARY_MODIFICATION', resourceType: 'PAYROLL', resourceId: payrollId, metadata: { operation: 'DELETE' } });
    return sendJson(res, 200, { success: true });
  } catch (err) {
    return handleDomainError(res, err, 'Failed to delete payroll record.');
  }
}

async function dashboardSummary(req, res) {
  try {
    return sendJson(res, 200, { success: true, ...await payrollQueryService.dashboardSummary() });
  } catch (err) {
    return handleDomainError(res, err, 'Failed to fetch dashboard summary.');
  }
}

module.exports = { listPayrollHistory, listPayslips, listPayrollReports, exportPayrollReport, downloadPayslip, deletePayrollRecord, dashboardSummary };
