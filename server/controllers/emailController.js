const { sendJson, sendError, readJsonBody } = require('../utils/http');
const payrollEmailService = require('../services/payrollEmailService');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const auditService = require('../services/auditService');

function handleError(res, err) {
  if (err instanceof PayrollDomainError) return sendError(res, err.statusCode, err.message, err.code);
  console.error('[payroll-email] delivery error', err);
  return sendError(res, 500, 'Failed to deliver salary slips.', 'PAYROLL_EMAIL_FAILED');
}

async function sendSlipsForPeriod(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  const payMonth = Number.parseInt(body.payMonth, 10);
  const payYear = Number.parseInt(body.payYear, 10);
  if (!Number.isInteger(payMonth) || payMonth < 1 || payMonth > 12 ||
      !Number.isInteger(payYear) || payYear < 2000 || payYear > 2100) {
    return sendError(res, 400, 'Valid payMonth and payYear are required.', 'PAYROLL_PERIOD_INVALID');
  }
  try {
    const result = await payrollEmailService.sendForPeriod(payMonth, payYear);
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYSLIP_EMAIL', resourceType: 'PAYROLL_RUN', resourceId: result.runId, metadata: { payMonth, payYear, total: result.total, queued: result.queued, invalid: result.invalid } });
    return sendJson(res, 200, { success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

async function sendSlipForRecord(req, res, payrollId) {
  try {
    const result = await payrollEmailService.sendForRecord(payrollId);
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYSLIP_EMAIL', resourceType: 'PAYROLL', resourceId: payrollId, metadata: { status: result.status } });
    return sendJson(res, 200, { success: true, result });
  } catch (err) {
    return handleError(res, err);
  }
}

async function listEmailStatus(req, res, runId) {
  try {
    const jobs = await payrollEmailService.listForRun(runId);
    return sendJson(res, 200, { success: true, runId, jobs: jobs.map((job) => ({
      jobId: job.JOB_ID, payrollId: job.PAYROLL_ID, employeeCode: job.EMPLOYEE_CODE,
      fullName: job.FULL_NAME, status: job.STATUS, attempts: job.ATTEMPT_COUNT,
      sentAt: job.SENT_AT || null, lastAttemptAt: job.LAST_ATTEMPT_AT || null,
      failureReason: job.STATUS === 'FAILED' ? job.FAILURE_REASON : null
    })) });
  } catch (err) { return handleError(res, err); }
}

module.exports = { sendSlipsForPeriod, sendSlipForRecord, listEmailStatus };
