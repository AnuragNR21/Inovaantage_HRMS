const db = require('../db');
const runRepository = require('../repositories/payrollRunRepository');
const payrollRepository = require('../repositories/payrollRepository');
const auditRepository = require('../repositories/payrollAuditRepository');
const workflowService = require('./payrollWorkflowService');
const { createPayrollInputDto } = require('../domain/payroll/payrollInputDto');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');
const { validateRows, validateEmployeeMatches } = require('./payrollValidationService');
const { calculatePayrollRow } = require('./payrollCalculationService');

function createPayrollProcessingService(dependencies = {}) {
  const database = dependencies.db || db;
  const runs = dependencies.runRepository || runRepository;
  const payroll = dependencies.payrollRepository || payrollRepository;
  const audit = dependencies.auditRepository || auditRepository;
  const workflow = dependencies.workflowService || workflowService;

  async function prepareRun(input) {
    return database.withConnection(async (conn) => {
      try {
        const existing = await runs.findByPeriod(conn, input.payMonth, input.payYear, true);
        if (existing) {
          if ([PAYROLL_STATES.VALIDATED, PAYROLL_STATES.APPROVED,
            PAYROLL_STATES.FINALIZED, PAYROLL_STATES.HOLD].includes(existing.STATUS)) {
            await conn.commit();
            return { runId: existing.RUN_ID, status: existing.STATUS, mode: 'APPEND' };
          }
          if (existing.STATUS === PAYROLL_STATES.FAILED) {
            await payroll.deleteByRun(conn, existing.RUN_ID);
            const restarted = await runs.restartFailed(conn, existing.RUN_ID, input.sourceFile, input.importId);
            if (!restarted) {
              throw new PayrollDomainError(409, 'PAYROLL_STATE_CONFLICT', 'Payroll state changed concurrently.');
            }
            await audit.recordEvent(conn, {
              runId: existing.RUN_ID,
              eventType: 'PAYROLL_RETRY_STARTED',
              fromState: PAYROLL_STATES.FAILED,
              toState: PAYROLL_STATES.PROCESSING,
              actorUserId: input.actorUserId,
              details: { sourceFile: input.sourceFile }
            });
            await conn.commit();
            return { runId: existing.RUN_ID, status: PAYROLL_STATES.PROCESSING, mode: 'RETRY' };
          }
          throw new PayrollDomainError(
            409,
            'DUPLICATE_PAYROLL_PERIOD',
            `A payroll run already exists for ${input.payMonth}/${input.payYear}.`
          );
        }
        const runId = await runs.create(conn, input);
        await audit.recordEvent(conn, {
          runId,
          eventType: 'PAYROLL_CREATED',
          fromState: null,
          toState: PAYROLL_STATES.DRAFT,
          actorUserId: input.actorUserId,
          details: { sourceFile: input.sourceFile }
        });
        await conn.commit();
        return { runId, status: PAYROLL_STATES.DRAFT, mode: 'NEW' };
      } catch (err) {
        await conn.rollback();
        if (err.errorNum === 1) {
          throw new PayrollDomainError(409, 'DUPLICATE_PAYROLL_PERIOD', 'A payroll run already exists for this period.');
        }
        throw err;
      }
    });
  }

  async function markFailed(runId, actorUserId, err) {
    await database.withConnection(async (conn) => {
      try {
        const run = await runs.getById(conn, runId, true);
        if (!run || run.STATUS === PAYROLL_STATES.FAILED || run.STATUS === PAYROLL_STATES.FINALIZED) {
          await conn.rollback();
          return;
        }
        await runs.updateState(conn, runId, run.STATUS, PAYROLL_STATES.FAILED, {
          errorMessage: String(err.message || 'Payroll processing failed.').slice(0, 500)
        });
        await audit.recordEvent(conn, {
          runId,
          eventType: 'PAYROLL_FAILED',
          fromState: run.STATUS,
          toState: PAYROLL_STATES.FAILED,
          actorUserId,
          details: { code: err.code || 'PAYROLL_PROCESSING_FAILED' }
        });
        await conn.commit();
      } catch (failureError) {
        await conn.rollback();
        console.error('[payroll] failed to record processing failure', failureError);
      }
    });
  }

  async function process(rawInput) {
    const input = createPayrollInputDto(rawInput);
    validateRows(input.rows);
    const prepared = await prepareRun(input);
    const runId = prepared.runId;
    try {
      if (prepared.status === PAYROLL_STATES.DRAFT) {
        await database.withConnection(async (conn) => {
          try {
            await workflow.transitionInTransaction(
              conn,
              runId,
              PAYROLL_STATES.PROCESSING,
              input.actorUserId,
              'PAYROLL_PROCESSING_STARTED'
            );
            await conn.commit();
          } catch (err) {
            await conn.rollback();
            throw err;
          }
        });
      }

      const result = await database.withConnection(async (conn) => {
        try {
          if (prepared.mode === 'APPEND') {
            const locked = await runs.getById(conn, runId, true);
            if (![PAYROLL_STATES.VALIDATED, PAYROLL_STATES.APPROVED,
              PAYROLL_STATES.FINALIZED, PAYROLL_STATES.HOLD].includes(locked?.STATUS)) {
              throw new PayrollDomainError(409, 'PAYROLL_STATE_CONFLICT', 'Payroll status changed; preview the file again.');
            }
          }
          const index = await payroll.getEmployeeMatchIndex(conn);
          const matchedRows = input.rows.map((row) => {
            const employee = payroll.matchEmployee(index, row);
            return employee ? { ...row, ...employee } : { ...row, employeeId: null };
          });
          validateEmployeeMatches(matchedRows);
          const employeeIds = new Set();
          for (const row of matchedRows) {
            if (employeeIds.has(row.employeeId)) {
              throw new PayrollDomainError(422, 'PAYROLL_INVALID', `Employee ${row.employeeCode} appears more than once.`);
            }
            employeeIds.add(row.employeeId);
          }
          const calculatedRows = matchedRows.map(calculatePayrollRow);
          if (prepared.mode === 'APPEND') {
            const existingRows = await payroll.findPeriodConflicts(
              conn, input.payMonth, input.payYear, matchedRows.map((row) => row.employeeId), true
            );
            const replacements = new Set(input.replacePayrollIds);
            const unresolved = existingRows.filter((row) => !replacements.has(Number(row.PAYROLL_ID)));
            if (unresolved.length) {
              throw new PayrollDomainError(
                422,
                'PAYROLL_DUPLICATE_RESOLUTION_REQUIRED',
                `Payroll data already exists for ${unresolved[0].EMPLOYEE_CODE}; choose which version to keep.`
              );
            }
          }
          if (input.replacePayrollIds.length) {
            await payroll.deleteByPayrollIds(conn, input.replacePayrollIds);
          }
          if (prepared.mode === 'APPEND' && prepared.status !== PAYROLL_STATES.VALIDATED) {
            await payroll.deleteDeliveryArtifactsByRun(conn, runId);
            await runs.resetAfterImportDeletion(conn, runId, await payroll.countByRun(conn, runId));
          }
          const run = {
            runId,
            importId: input.importId,
            payMonth: input.payMonth,
            payYear: input.payYear,
            sourceFile: input.sourceFile,
            totalRows: calculatedRows.length
          };
          for (const row of calculatedRows) await payroll.insertPayroll(conn, run, row);
          await payroll.insertUploadBatch(conn, run, input.actorUsername);
          const totalRows = await payroll.countByRun(conn, runId);
          if (prepared.mode === 'APPEND') {
            await runs.updateCounts(conn, runId, totalRows);
            await audit.recordEvent(conn, {
              runId, eventType: 'PAYROLL_IMPORT_APPENDED',
              fromState: PAYROLL_STATES.VALIDATED, toState: PAYROLL_STATES.VALIDATED,
              actorUserId: input.actorUserId,
              details: { importId: input.importId, addedRows: calculatedRows.length, replacedRows: input.replacePayrollIds.length }
            });
          } else {
            await workflow.transitionInTransaction(
              conn, runId, PAYROLL_STATES.VALIDATED, input.actorUserId, 'PAYROLL_VALIDATED',
              {
                totalRows, validatedRows: totalRows,
                auditDetails: { warnings: input.parseWarnings }
              }
            );
          }
          await conn.commit();
          return {
            runId, status: PAYROLL_STATES.VALIDATED, rows: calculatedRows.length,
            totalRows, replacedRows: input.replacePayrollIds.length
          };
        } catch (err) {
          await conn.rollback();
          throw err;
        }
      });
      return result;
    } catch (err) {
      if (prepared.mode !== 'APPEND') await markFailed(runId, input.actorUserId, err);
      err.runId = runId;
      throw err;
    }
  }

  return { process };
}

module.exports = createPayrollProcessingService();
module.exports.createPayrollProcessingService = createPayrollProcessingService;
