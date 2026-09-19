const db = require('../db');
const repository = require('../repositories/payslipEmailRepository');
const payslipRepository = require('../repositories/payslipRepository');
const mailer = require('../utils/mailer');
const { buildPayslipPdfBuffer } = require('../utils/payslipBuffer');

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function safeFailureReason(result) {
  if (!result) return 'Email delivery failed.';
  if (result.skipped) return 'Email delivery is disabled.';
  if (/not configured|disabled/i.test(result.error || '')) return String(result.error).slice(0, 500);
  return 'Email delivery failed.';
}

function createPayrollEmailWorker(dependencies = {}) {
  const database = dependencies.db || db;
  const jobs = dependencies.jobRepository || repository;
  const payslips = dependencies.payslipRepository || payslipRepository;
  const sendMail = dependencies.sendMail || mailer.sendMail;
  const buildPdf = dependencies.buildPdf || buildPayslipPdfBuffer;
  const workerId = dependencies.workerId || `worker-${process.pid}`;
  const leaseMinutes = dependencies.leaseMinutes || 10;
  const maxJobsPerCycle = dependencies.maxJobsPerCycle || 25;

  async function processOne(job) {
    try {
      const document = await database.withConnection((conn) => payslips.getForPayroll(conn, job.PAYROLL_ID));
      if (!document || (document.RUN_STATUS && document.RUN_STATUS !== 'FINALIZED') ||
          (document.APPROVAL_STATUS && document.APPROVAL_STATUS !== 'FINALIZED') ||
          document.STATUS !== 'GENERATED' || !Buffer.isBuffer(document.CONTENT)) {
        await database.withConnection((conn) => jobs.markFailed(conn, job.JOB_ID, job.processingToken, 'Payslip is not available for delivery.'));
        return 'FAILED';
      }
      const delivery = await sendMail({
        to: job.EMAIL_ADDRESS,
        subject: `Salary Slip - ${MONTH_NAMES[document.PAY_MONTH]} ${document.PAY_YEAR}`,
        text: `Dear ${document.FULL_NAME},\n\nPlease find attached your salary slip for ${MONTH_NAMES[document.PAY_MONTH]} ${document.PAY_YEAR}.\n\nRegards,\n${process.env.COMPANY_NAME || 'HR Team'}`,
        html: `<p>Dear ${String(document.FULL_NAME).replace(/[&<>"']/g, '')},</p><p>Please find attached your salary slip for <strong>${MONTH_NAMES[document.PAY_MONTH]} ${document.PAY_YEAR}</strong>.</p>`,
        attachments: [{
          filename: `Payslip_${document.EMPLOYEE_CODE}_${document.PAY_MONTH}_${document.PAY_YEAR}.pdf`,
          content: document.CONTENT,
          contentType: 'application/pdf'
        }]
      });
      await database.withConnection(async (conn) => {
        if (delivery.success) await jobs.markSent(conn, job.JOB_ID, job.processingToken);
        else await jobs.markFailed(conn, job.JOB_ID, job.processingToken, safeFailureReason(delivery));
      });
      return delivery.success ? 'SENT' : 'FAILED';
    } catch (err) {
      console.error('[payroll-email-worker] job failed', err.message);
      await database.withConnection(async (conn) => {
        try { await jobs.markFailed(conn, job.JOB_ID, job.processingToken, 'Email delivery failed.'); }
        catch (failureError) { await conn.rollback(); }
      });
      return 'FAILED';
    }
  }

  async function processPending(limit = maxJobsPerCycle) {
    const summary = { processed: 0, sent: 0, failed: 0 };
    for (let index = 0; index < limit; index += 1) {
      const job = await database.withConnection(async (conn) => jobs.claimNext(conn, workerId, leaseMinutes));
      if (!job) break;
      summary.processed += 1;
      if (await processOne(job) === 'SENT') summary.sent += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  function start(intervalMs = 5000) {
    const timer = setInterval(() => {
      processPending().catch((err) => console.error('[payroll-email-worker] cycle failed', err.message));
    }, intervalMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  return { processPending, processOne, start };
}

module.exports = createPayrollEmailWorker();
module.exports.createPayrollEmailWorker = createPayrollEmailWorker;
