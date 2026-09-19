const crypto = require('crypto');
const db = require('../db');
const repository = require('../repositories/payslipRepository');
const { buildPayslipPdfBuffer } = require('../utils/payslipBuffer');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');

function createPayslipGenerationService(dependencies = {}) {
  const database = dependencies.db || db;
  const payslips = dependencies.payslipRepository || repository;
  const buildPdf = dependencies.buildPdf || buildPayslipPdfBuffer;
  const leaseMinutes = dependencies.leaseMinutes || 10;

  async function assertFinalized(runId) {
    return database.withConnection(async (conn) => {
      const run = await payslips.getRun(conn, runId);
      if (!run) throw new PayrollDomainError(404, 'PAYROLL_RUN_NOT_FOUND', 'Payroll run not found.');
      if (run.STATUS !== PAYROLL_STATES.FINALIZED) {
        throw new PayrollDomainError(409, 'PAYROLL_NOT_FINALIZED', 'Payslips are available only after payroll finalization.');
      }
      return run;
    });
  }

  async function getGenerationRow(payrollId) {
    return database.withConnection((conn) => payslips.getGenerationData(conn, payrollId));
  }

  async function generateOne(payrollId) {
    const claim = await database.withConnection(async (conn) => {
      try {
        return await payslips.claim(conn, payrollId, leaseMinutes);
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
    if (claim.state !== 'CLAIMED') return { payrollId, status: claim.state === 'GENERATED' ? 'GENERATED' : 'PENDING' };

    try {
      const row = await getGenerationRow(payrollId);
      if (!row) throw new Error('Payroll record no longer exists.');
      const employee = {
        EMPLOYEE_CODE: row.EMP_CODE,
        FULL_NAME: row.FULL_NAME,
        DEPARTMENT: row.DEPARTMENT,
        DESIGNATION: row.DESIGNATION,
        BANK_ACCOUNT: row.BANK_ACCOUNT,
        BANK_NAME: row.BANK_NAME,
        IFSC_CODE: row.IFSC_CODE,
        PAN_NO: row.PAN_NO
      };
      const buffer = await buildPdf(row, employee, { generatedAt: new Date() });
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Generated payslip was empty.');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      await database.withConnection(async (conn) => {
        try {
          await payslips.markGenerated(conn, payrollId, claim.token, buffer, sha256);
        } catch (err) {
          await conn.rollback();
          throw err;
        }
      });
      return { payrollId, status: 'GENERATED' };
    } catch (err) {
      await database.withConnection(async (conn) => {
        try {
          await payslips.markFailed(conn, payrollId, claim.token, 'Could not generate the payslip PDF.');
        } catch (failureError) {
          await conn.rollback();
          console.error('[payslip] failed to record generation failure', failureError);
        }
      });
      return { payrollId, status: 'FAILED', message: 'Could not generate the payslip PDF.' };
    }
  }

  async function generateForRun(runId) {
    await assertFinalized(runId);
    await database.withConnection(async (conn) => {
      try {
        await payslips.ensurePendingForRun(conn, runId);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
    const documents = await database.withConnection((conn) => payslips.listForRun(conn, runId));
    const results = [];
    for (const document of documents) results.push(await generateOne(document.PAYROLL_ID));
    const finalDocuments = await database.withConnection((conn) => payslips.listForRun(conn, runId));
    return {
      runId,
      total: finalDocuments.length,
      generated: finalDocuments.filter((item) => item.STATUS === 'GENERATED').length,
      pending: finalDocuments.filter((item) => item.STATUS === 'PENDING').length,
      failed: finalDocuments.filter((item) => item.STATUS === 'FAILED').length,
      results: finalDocuments.map((item) => ({
        payrollId: item.PAYROLL_ID,
        employeeCode: item.EMPLOYEE_CODE,
        fullName: item.FULL_NAME,
        status: item.STATUS,
        attempts: item.ATTEMPT_COUNT,
        error: item.STATUS === 'FAILED' ? 'Payslip generation failed.' : undefined
      }))
    };
  }

  async function listStatus(runId) {
    await assertFinalized(runId);
    return database.withConnection(async (conn) => {
      await payslips.ensurePendingForRun(conn, runId);
      await conn.commit();
      return payslips.listForRun(conn, runId);
    });
  }

  async function ensureAndGenerateOne(payrollId) {
    const row = await database.withConnection((conn) => payslips.getGenerationData(conn, payrollId));
    if (!row) throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
    await assertFinalized(row.RUN_ID);
    await database.withConnection(async (conn) => {
      try {
        await payslips.ensurePendingForRun(conn, row.RUN_ID);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    });
    await generateOne(payrollId);
  }

  async function getDownload(req, payrollId) {
    let document = await database.withConnection((conn) => payslips.getForPayroll(conn, payrollId));
    if (!document) {
      const payroll = await getGenerationRow(payrollId);
      if (payroll && req && req.dataScope && req.dataScope.type === 'SELF' &&
          Number(payroll.EMPLOYEE_ID) !== Number(req.dataScope.employeeId)) {
        throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
      }
    }
    if (document && req && req.dataScope && req.dataScope.type === 'SELF' &&
        Number(document.EMPLOYEE_ID) !== Number(req.dataScope.employeeId)) {
      throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
    }
    if (!document) {
      await ensureAndGenerateOne(payrollId);
      document = await database.withConnection((conn) => payslips.getForPayroll(conn, payrollId));
    }
    if (!document) throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
    if (req && req.dataScope && req.dataScope.type === 'SELF' &&
        Number(document.EMPLOYEE_ID) !== Number(req.dataScope.employeeId)) {
      throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
    }
    if (document.RUN_STATUS !== PAYROLL_STATES.FINALIZED) {
      throw new PayrollDomainError(409, 'PAYROLL_NOT_FINALIZED', 'Payslips are available only after payroll finalization.');
    }
    if (document.APPROVAL_STATUS === PAYROLL_STATES.HOLD) {
      throw new PayrollDomainError(409, 'PAYROLL_ROW_ON_HOLD', 'This employee payslip is on hold and is not available.');
    }
    if (document.STATUS !== 'GENERATED' || !Buffer.isBuffer(document.CONTENT)) {
      throw new PayrollDomainError(
        409,
        document.STATUS === 'FAILED' ? 'PAYSLIP_GENERATION_FAILED' : 'PAYSLIP_NOT_READY',
        document.STATUS === 'FAILED' ? 'This payslip could not be generated. Ask payroll to retry generation.' : 'This payslip is still being generated.'
      );
    }
    return {
      content: document.CONTENT,
      fileName: `Payslip_${document.EMPLOYEE_CODE}_${document.PAY_MONTH}_${document.PAY_YEAR}.pdf`
    };
  }

  return { generateForRun, generateOne, listStatus, ensureAndGenerateOne, getDownload };
}

module.exports = createPayslipGenerationService();
module.exports.createPayslipGenerationService = createPayslipGenerationService;
