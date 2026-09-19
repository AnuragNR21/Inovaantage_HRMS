const db = require('../db');
const runRepository = require('../repositories/payrollRunRepository');
const auditRepository = require('../repositories/payrollAuditRepository');
const { PAYROLL_STATES, canTransition } = require('../domain/payroll/payrollStates');
const { PayrollDomainError } = require('../domain/payroll/payrollError');

function createPayrollWorkflowService(dependencies = {}) {
  const database = dependencies.db || db;
  const runs = dependencies.runRepository || runRepository;
  const audit = dependencies.auditRepository || auditRepository;

  async function transitionInTransaction(conn, runId, toState, actorUserId, eventType, values = {}) {
    const run = await runs.getById(conn, runId, true);
    if (!run) throw new PayrollDomainError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found.');
    if (values.requiredFromState && run.STATUS !== values.requiredFromState) {
      throw new PayrollDomainError(409, 'INVALID_PAYROLL_STATE_TRANSITION', `Payroll must be ${values.requiredFromState} before this operation.`);
    }
    if (!canTransition(run.STATUS, toState)) {
      throw new PayrollDomainError(
        409,
        'INVALID_PAYROLL_STATE_TRANSITION',
        `Payroll cannot transition from ${run.STATUS} to ${toState}.`
      );
    }
    if (toState === PAYROLL_STATES.APPROVED &&
        (Number(run.TOTAL_ROWS) < 1 || Number(run.VALIDATED_ROWS) !== Number(run.TOTAL_ROWS))) {
      throw new PayrollDomainError(409, 'PAYROLL_NOT_READY', 'Payroll must contain fully validated records before approval.');
    }
    // Keep the legacy run-level endpoints compatible with row-level status.
    // Row-scoped operations pass rowScoped=true and manage only their selection.
    if (toState === PAYROLL_STATES.FINALIZED && !values.rowScoped) {
      await conn.execute(
        `UPDATE payroll SET approval_status = 'FINALIZED'
          WHERE run_id = :runId AND approval_status <> 'HOLD'`,
        { runId }
      );
    }
    const changed = await runs.updateState(conn, runId, run.STATUS, toState, values);
    if (!changed) {
      throw new PayrollDomainError(409, 'PAYROLL_STATE_CONFLICT', 'Payroll state changed concurrently.');
    }
    await audit.recordEvent(conn, {
      runId,
      eventType,
      fromState: run.STATUS,
      toState,
      actorUserId,
      details: values.auditDetails || null
    });
    return { ...run, STATUS: toState };
  }

  async function transition(runId, toState, actorUserId, eventType, values = {}) {
    return database.withConnection(async (conn) => {
      try {
        const result = await transitionInTransaction(conn, runId, toState, actorUserId, eventType, values);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
  }

  return {
    transitionInTransaction,
    approve: (runId, actorUserId) => transition(
      runId, PAYROLL_STATES.APPROVED, actorUserId, 'PAYROLL_APPROVED', { approvedBy: actorUserId }
    ),
    finalize: (runId, actorUserId) => transition(
      runId, PAYROLL_STATES.FINALIZED, actorUserId, 'PAYROLL_FINALIZED', { finalizedBy: actorUserId }
    ),
    hold: (runId, actorUserId) => transition(
      runId, PAYROLL_STATES.HOLD, actorUserId, 'PAYROLL_HELD', { requiredFromState: PAYROLL_STATES.FINALIZED }
    ),
    release: (runId, actorUserId) => transition(
      runId, PAYROLL_STATES.FINALIZED, actorUserId, 'PAYROLL_RELEASED', { requiredFromState: PAYROLL_STATES.HOLD }
    )
  };
}

module.exports = createPayrollWorkflowService();
module.exports.createPayrollWorkflowService = createPayrollWorkflowService;
