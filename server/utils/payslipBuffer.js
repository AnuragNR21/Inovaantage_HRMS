const { PassThrough } = require('stream');
const { generatePayslipPdf } = require('./pdfGenerator');

/**
 * Renders a payslip to an in-memory Buffer instead of streaming it straight
 * to an HTTP response. Reuses generatePayslipPdf() exactly as-is (it only
 * needs any writable stream), so the existing download route/behaviour is
 * completely unaffected.
 */
function buildPayslipPdfBuffer(payrollRow, employeeRow, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (chunk) => chunks.push(chunk));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      generatePayslipPdf(payrollRow, employeeRow, sink, options);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildPayslipPdfBuffer };
