const db = require('../db');
const { applyEmployeeScope } = require('../authorization/dataScope');
const { PayrollDomainError } = require('../domain/payroll/payrollError');
const { PAYROLL_STATES } = require('../domain/payroll/payrollStates');

async function getPayslip(req, payrollId) {
  const conditions = ['p.payroll_id = :id'];
  const binds = { id: payrollId };
  applyEmployeeScope(req, conditions, binds, 'p.employee_id');
  const result = await db.execute(
    `SELECT p.*, r.status AS run_status, e.full_name, e.department, e.designation,
            e.employee_code AS emp_code, e.bank_account, e.bank_name, e.ifsc_code, e.pan_no
       FROM payroll p
       JOIN payroll_runs r ON r.run_id = p.run_id
       JOIN employees e ON e.employee_id = p.employee_id
      WHERE ${conditions.join(' AND ')}`,
    binds
  );
  if (!result.rows.length) {
    throw new PayrollDomainError(404, 'PAYROLL_RECORD_NOT_FOUND', 'Payroll record not found.');
  }
  const payroll = result.rows[0];
  if (payroll.RUN_STATUS !== PAYROLL_STATES.FINALIZED) {
    throw new PayrollDomainError(409, 'PAYROLL_NOT_FINALIZED', 'Payslips are available only after payroll finalization.');
  }
  if (payroll.APPROVAL_STATUS === PAYROLL_STATES.HOLD) {
    throw new PayrollDomainError(409, 'PAYROLL_ROW_ON_HOLD', 'This employee payslip is on hold and is not available.');
  }
  return {
    payroll,
    employee: {
      EMPLOYEE_CODE: payroll.EMP_CODE,
      FULL_NAME: payroll.FULL_NAME,
      DEPARTMENT: payroll.DEPARTMENT,
      DESIGNATION: payroll.DESIGNATION,
      BANK_ACCOUNT: payroll.BANK_ACCOUNT,
      BANK_NAME: payroll.BANK_NAME,
      IFSC_CODE: payroll.IFSC_CODE,
      PAN_NO: payroll.PAN_NO
    },
    fileName: `Payslip_${payroll.EMP_CODE}_${payroll.PAY_MONTH}_${payroll.PAY_YEAR}.pdf`
  };
}

module.exports = { getPayslip };
