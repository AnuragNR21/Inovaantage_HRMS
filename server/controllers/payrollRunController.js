const { sendJson, sendError, readJsonBody } = require('../utils/http');
const payrollWorkflowService = require('../services/payrollWorkflowService');
const payslipGenerationService = require('../services/payslipGenerationService');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const auditService = require('../services/auditService');
const payrollRowWorkflowService = require('../services/payrollRowWorkflowService');

function handleError(res, err) {
  if (err instanceof PayrollDomainError) return sendError(res, err.statusCode, err.message, err.code);
  console.error('[payroll-run] workflow error', err);
  return sendError(res, 500, 'Payroll workflow operation failed.', 'PAYROLL_WORKFLOW_FAILED');
}

async function approve(req, res, runId) {
  try {
    const run = await payrollWorkflowService.approve(runId, req.session.userId);
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYROLL_APPROVAL', resourceType: 'PAYROLL_RUN', resourceId: runId, metadata: { status: run.STATUS } });
    return sendJson(res, 200, { success: true, runId, status: run.STATUS });
  } catch (err) {
    return handleError(res, err);
  }
}

async function finalize(req, res, runId) {
  try {
    const run = await payrollWorkflowService.finalize(runId, req.session.userId);
    let generation;
    try {
      generation = await payslipGenerationService.generateForRun(runId);
    } catch (generationError) {
      console.error('[payslip] generation setup failed after finalization', generationError);
      generation = { runId, total: 0, generated: 0, pending: 0, failed: 1 };
    }
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYROLL_FINALIZATION', resourceType: 'PAYROLL_RUN', resourceId: runId, metadata: { status: run.STATUS, generated: generation.generated, failed: generation.failed } });
    return sendJson(res, 200, { success: true, runId, status: run.STATUS, generation });
  } catch (err) {
    return handleError(res, err);
  }
}

async function generatePayslips(req, res, runId) {
  try {
    const result = await payslipGenerationService.generateForRun(runId);
    await auditService.record({ actorUserId: req.session.userId, action: 'PAYSLIP_GENERATION', resourceType: 'PAYROLL_RUN', resourceId: runId, metadata: { total: result.total, generated: result.generated, failed: result.failed } });
    return sendJson(res, 200, { success: true, ...result });
  } catch (err) {
    return handleError(res, err);
  }
}

async function listPayslips(req, res, runId) {
  try {
    const documents = await payslipGenerationService.listStatus(runId);
    return sendJson(res, 200, {
      success: true,
      runId,
      documents: documents.map((document) => ({
        payrollId: document.PAYROLL_ID,
        employeeCode: document.EMPLOYEE_CODE,
        fullName: document.FULL_NAME,
        status: document.STATUS,
        attempts: document.ATTEMPT_COUNT,
        generatedAt: document.GENERATED_AT || null,
        error: document.STATUS === 'FAILED' ? 'Payslip generation failed.' : undefined
      }))
    });
  } catch (err) {
    return handleError(res, err);
  }
}

async function updateAvailability(req, res, runId) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  const status = String(body.status || '').toUpperCase();
  if (!['FINALIZED', 'HOLD'].includes(status)) return sendError(res, 400, 'Status must be FINALIZED or HOLD.', 'PAYROLL_STATUS_INVALID');
  try {
    const run = status === 'HOLD'
      ? await payrollWorkflowService.hold(runId, req.session.userId)
      : await payrollWorkflowService.release(runId, req.session.userId);
    await auditService.record({ actorUserId: req.session.userId, action: status === 'HOLD' ? 'PAYROLL_HOLD' : 'PAYROLL_RELEASE', resourceType: 'PAYROLL_RUN', resourceId: runId, metadata: { status } });
    return sendJson(res, 200, { success: true, runId, status: run.STATUS });
  } catch (err) { return handleError(res, err); }
}

async function updateRows(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message, 'INVALID_REQUEST'); }
  try {
    const result = await payrollRowWorkflowService.updateRows({
      payrollIds: body.payrollIds,
      action: body.action,
      actorUserId: req.session.userId
    });
    await auditService.record({
      actorUserId: req.session.userId,
      action: `PAYROLL_ROW_${result.action}`,
      resourceType: 'PAYROLL',
      metadata: { payrollIds: body.payrollIds, updated: result.updated }
    });
    const generations = [];
    for (const transitionedRun of result.transitionedRuns || []) {
      if (transitionedRun.status !== 'FINALIZED') continue;
      try {
        generations.push(await payslipGenerationService.generateForRun(transitionedRun.runId));
      } catch (generationError) {
        console.error('[payslip] row finalization generation failed', generationError.message);
        generations.push({ runId: transitionedRun.runId, generated: 0, failed: 1 });
      }
    }
    return sendJson(res, 200, { success: true, ...result, generations });
  } catch (err) { return handleError(res, err); }
}

module.exports = { approve, finalize, generatePayslips, listPayslips, updateAvailability, updateRows };
