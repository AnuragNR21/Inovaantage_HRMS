const db = require('../db');
const emailJobs = require('../repositories/payslipEmailRepository');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');

function createPayrollEmailService(dependencies = {}) {
  const database = dependencies.db || db;
  const jobs = dependencies.jobRepository || emailJobs;

  async function getFinalizedRun(runId) {
    const result = await database.execute('SELECT run_id, status FROM payroll_runs WHERE run_id = :runId', { runId });
    if (!result.rows.length) throw new PayrollDomainError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found.');
    if (result.rows[0].STATUS !== PAYROLL_STATES.FINALIZED) {
      throw new PayrollDomainError(409, 'PAYROLL_NOT_FINALIZED', 'Payroll must be finalized before payslips can be emailed.');
    }
    return result.rows[0];
  }

  async function enqueueRun(runId) {
    await getFinalizedRun(runId);
    return database.withConnection(async (conn) => {
      try {
        const result = await jobs.enqueueForRun(conn, runId);
        await conn.commit();
        return result;
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
  }

  async function sendForPeriod(payMonth, payYear) {
    const result = await database.execute('SELECT run_id FROM payroll_runs WHERE pay_month = :payMonth AND pay_year = :payYear', { payMonth, payYear });
    if (!result.rows.length) throw new PayrollDomainError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found.');
    const queued = await enqueueRun(result.rows[0].RUN_ID);
    return { runId: result.rows[0].RUN_ID, total: queued.created, queued: queued.created - queued.invalid, invalid: queued.invalid, message: 'Payslip emails have been queued for background delivery.' };
  }

  async function sendForRecord(payrollId) {
    const result = await database.execute('SELECT run_id, approval_status FROM payroll WHERE payroll_id = :payrollId', { payrollId });
    if (!result.rows.length) throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
    if (result.rows[0].APPROVAL_STATUS && result.rows[0].APPROVAL_STATUS !== PAYROLL_STATES.FINALIZED) {
      throw new PayrollDomainError(409, 'PAYROLL_ROW_ON_HOLD', 'Payslip email delivery is blocked for this employee while the payroll row is on hold.');
    }
    const run = await getFinalizedRun(result.rows[0].RUN_ID);
    return database.withConnection(async (conn) => {
      try {
        const existing = await jobs.getJob(conn, payrollId);
        if (existing) {
          if (existing.STATUS === 'FAILED' && Number(existing.ATTEMPT_COUNT) < Number(existing.MAX_ATTEMPTS)) {
            await jobs.requeueFailed(conn, payrollId);
            await conn.commit();
            return { payrollId, status: 'PENDING', message: 'Payslip email retry queued for background delivery.' };
          }
          await conn.commit();
          return { payrollId, status: existing.STATUS, message: existing.STATUS === 'FAILED' ? 'This payslip cannot be delivered until the employee email is corrected.' : 'Payslip email is already queued or delivered.' };
        }
        await jobs.enqueueForRun(conn, run.RUN_ID, payrollId);
        const job = await jobs.getJob(conn, payrollId);
        await conn.commit();
        return { payrollId, status: job ? job.STATUS : 'PENDING', message: 'Payslip email queued for background delivery.' };
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
  }

  async function listForRun(runId) {
    await getFinalizedRun(runId);
    return database.withConnection((conn) => jobs.listForRun(conn, runId));
  }

  return { sendForPeriod, sendForRecord, listForRun, enqueueRun };
}

module.exports = createPayrollEmailService();
module.exports.createPayrollEmailService = createPayrollEmailService;
