const db = require('../db');
const runRepository = require('../repositories/payrollRunRepository');
const auditRepository = require('../repositories/payrollAuditRepository');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');
const { PayrollDomainError } = require('../domain/payroll/payrollError');

async function deleteRecord(payrollId, actorUserId) {
  return db.withConnection(async (conn) => {
    try {
      const record = await conn.execute(
        `SELECT payroll_id, run_id, employee_id FROM payroll WHERE payroll_id = :payrollId`,
        { payrollId }
      );
      if (!record.rows.length) {
        throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
      }
      const row = record.rows[0];
      const run = await runRepository.getById(conn, row.RUN_ID, true);
      if (run.STATUS !== PAYROLL_STATES.VALIDATED) {
        throw new PayrollDomainError(
          409,
          'PAYROLL_RECORD_IMMUTABLE',
          `Payroll records cannot be modified while the run is ${run.STATUS}.`
        );
      }
      await conn.execute(`DELETE FROM payroll WHERE payroll_id = :payrollId`, { payrollId });
      const remaining = await conn.execute(
        `SELECT COUNT(*) AS cnt FROM payroll WHERE run_id = :runId`,
        { runId: row.RUN_ID }
      );
      await runRepository.updateCounts(conn, row.RUN_ID, Number(remaining.rows[0].CNT));
      await auditRepository.recordEvent(conn, {
        runId: row.RUN_ID,
        eventType: 'PAYROLL_RECORD_DELETED',
        fromState: run.STATUS,
        toState: run.STATUS,
        actorUserId,
        details: { payrollId, employeeId: row.EMPLOYEE_ID }
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
}

module.exports = { deleteRecord };
