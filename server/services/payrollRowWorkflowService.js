const db = require('../db');
const payrollWorkflowService = require('./payrollWorkflowService');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');
const { PayrollDomainError } = require('../domain/payroll/payrollError');

const ACTIONS = Object.freeze({ APPROVE: 'APPROVE', FINALIZE: 'FINALIZE', HOLD: 'HOLD' });

function placeholders(values, prefix, binds) {
  return values.map((value, index) => {
    const key = `${prefix}${index}`;
    binds[key] = value;
    return `:${key}`;
  }).join(', ');
}

function normalizeIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 1000) {
    throw new PayrollDomainError(422, 'PAYROLL_ROWS_REQUIRED', 'Select between one and 1,000 payroll records.');
  }
  const ids = [...new Set(value.map((id) => Number(id)))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new PayrollDomainError(422, 'PAYROLL_ROWS_INVALID', 'Payroll record selection is invalid.');
  }
  return ids;
}

async function updateRows({ payrollIds, action, actorUserId }) {
  const ids = normalizeIds(payrollIds);
  const normalizedAction = String(action || '').toUpperCase();
  if (!Object.values(ACTIONS).includes(normalizedAction)) {
    throw new PayrollDomainError(422, 'PAYROLL_ROW_ACTION_INVALID', 'Action must be APPROVE, FINALIZE, or HOLD.');
  }

  return db.withConnection(async (conn) => {
    try {
      const binds = {};
      const selected = await conn.execute(
        `SELECT payroll_id, run_id, approval_status
           FROM payroll
          WHERE payroll_id IN (${placeholders(ids, 'payroll', binds)})
          FOR UPDATE`,
        binds
      );
      if (selected.rows.length !== ids.length) {
        throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'One or more selected payroll records were not found.');
      }

      const runIds = [...new Set(selected.rows.map((row) => Number(row.RUN_ID)))];
      const runBinds = {};
      const runResult = await conn.execute(
        `SELECT run_id, status FROM payroll_runs
          WHERE run_id IN (${placeholders(runIds, 'run', runBinds)})
          FOR UPDATE`,
        runBinds
      );
      const runStatusById = new Map(runResult.rows.map((row) => [Number(row.RUN_ID), row.STATUS]));
      const selectedWithRuns = selected.rows.map((row) => ({
        ...row,
        RUN_STATUS: runStatusById.get(Number(row.RUN_ID))
      }));

      for (const row of selectedWithRuns) {
        const rowStatus = row.APPROVAL_STATUS || PAYROLL_STATES.VALIDATED;
        if (normalizedAction === ACTIONS.APPROVE &&
            !([PAYROLL_STATES.VALIDATED, PAYROLL_STATES.HOLD].includes(rowStatus) &&
              [PAYROLL_STATES.VALIDATED, PAYROLL_STATES.APPROVED, PAYROLL_STATES.FINALIZED].includes(row.RUN_STATUS))) {
          throw new PayrollDomainError(409, 'PAYROLL_ROW_STATE_INVALID', 'Only validated payroll rows can be approved.');
        }
        if (normalizedAction === ACTIONS.FINALIZE &&
            !(rowStatus === PAYROLL_STATES.APPROVED &&
              [PAYROLL_STATES.VALIDATED, PAYROLL_STATES.APPROVED, PAYROLL_STATES.FINALIZED].includes(row.RUN_STATUS))) {
          throw new PayrollDomainError(409, 'PAYROLL_ROW_STATE_INVALID', 'Only approved payroll rows can be finalized.');
        }
        if (normalizedAction === ACTIONS.HOLD &&
            [PAYROLL_STATES.DRAFT, PAYROLL_STATES.PROCESSING, PAYROLL_STATES.FAILED].includes(row.RUN_STATUS)) {
          throw new PayrollDomainError(409, 'PAYROLL_ROW_STATE_INVALID', 'Payroll must be validated before a row can be put on hold.');
        }
      }

      const nextStatus = normalizedAction === ACTIONS.APPROVE ? PAYROLL_STATES.APPROVED
        : normalizedAction === ACTIONS.FINALIZE ? PAYROLL_STATES.FINALIZED : PAYROLL_STATES.HOLD;
      for (const row of selectedWithRuns) {
        await conn.execute(
          `UPDATE payroll SET approval_status = :nextStatus WHERE payroll_id = :payrollId`,
          { nextStatus, payrollId: row.PAYROLL_ID }
        );
      }

      const transitionedRuns = [];
      for (const runId of runIds) {
        const runRows = await conn.execute(
          `SELECT approval_status FROM payroll WHERE run_id = :runId`, { runId }
        );
        const statuses = runRows.rows.map((row) => row.APPROVAL_STATUS);
        let currentRun = runStatusById.get(runId);
        const nonHeldStatuses = statuses.filter((status) => status !== PAYROLL_STATES.HOLD);
        const approvalReady = nonHeldStatuses.length > 0 && nonHeldStatuses.every((status) =>
          [PAYROLL_STATES.APPROVED, PAYROLL_STATES.FINALIZED].includes(status));
        if (normalizedAction === ACTIONS.APPROVE && currentRun === PAYROLL_STATES.VALIDATED && approvalReady) {
          const run = await payrollWorkflowService.transitionInTransaction(
            conn, runId, PAYROLL_STATES.APPROVED, actorUserId, 'PAYROLL_APPROVED',
            { approvedBy: actorUserId, rowScoped: true, auditDetails: { scope: 'EMPLOYEE_ROWS', payrollIds: ids } }
          );
          transitionedRuns.push({ runId, status: run.STATUS });
          currentRun = run.STATUS;
        }
        if (normalizedAction === ACTIONS.FINALIZE && currentRun === PAYROLL_STATES.VALIDATED && approvalReady) {
          const run = await payrollWorkflowService.transitionInTransaction(
            conn, runId, PAYROLL_STATES.APPROVED, actorUserId, 'PAYROLL_APPROVED',
            { approvedBy: actorUserId, rowScoped: true, auditDetails: { scope: 'EMPLOYEE_ROWS', payrollIds: ids } }
          );
          transitionedRuns.push({ runId, status: run.STATUS });
          currentRun = run.STATUS;
        }
        if (normalizedAction === ACTIONS.FINALIZE && currentRun === PAYROLL_STATES.APPROVED &&
            statuses.length && statuses.every((status) => [PAYROLL_STATES.FINALIZED, PAYROLL_STATES.HOLD].includes(status))) {
          const run = await payrollWorkflowService.transitionInTransaction(
            conn, runId, PAYROLL_STATES.FINALIZED, actorUserId, 'PAYROLL_FINALIZED',
            { finalizedBy: actorUserId, rowScoped: true, auditDetails: { scope: 'EMPLOYEE_ROWS', payrollIds: ids } }
          );
          transitionedRuns.push({ runId, status: run.STATUS });
        }
        if (normalizedAction === ACTIONS.FINALIZE && currentRun === PAYROLL_STATES.FINALIZED &&
            statuses.length && statuses.every((status) => [PAYROLL_STATES.FINALIZED, PAYROLL_STATES.HOLD].includes(status))) {
          transitionedRuns.push({ runId, status: PAYROLL_STATES.FINALIZED });
        }
      }

      await conn.commit();
      return { action: normalizedAction, updated: selectedWithRuns.length, transitionedRuns };
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
}

module.exports = { updateRows, ACTIONS, normalizeIds };
