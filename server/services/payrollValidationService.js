const { PayrollDomainError } = require('../domain/payroll/payrollError');

const NUMERIC_FIELDS = [
  'working_days', 'present_days', 'absent_days', 'paid_leave_days', 'lop_days',
  'half_days', 'late_marks', 'ot_hours', 'basic_salary', 'hra', 'da',
  'conveyance', 'medical_allowance', 'special_allowance', 'professional_development',
  'other_allowance', 'food_allowance', 'bonus', 'other_earnings', 'total_earnings',
  'employer_contribution', 'lop_amount', 'gross_salary', 'provident_fund', 'esi',
  'professional_tax', 'income_tax', 'other_deductions', 'total_deductions', 'net_salary'
];

function validateRows(rows) {
  const errors = [];
  const identifiers = new Set();
  rows.forEach((row, index) => {
    const label = String(row.employee_code || row.employee_name || '').trim();
    if (!label) errors.push(`Row ${index + 1}: employee identifier is required.`);
    const key = label.toLowerCase();
    if (key && identifiers.has(key)) errors.push(`Row ${index + 1}: duplicate employee "${label}".`);
    identifiers.add(key);
    for (const field of NUMERIC_FIELDS) {
      const value = Number(row[field] || 0);
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`Row ${index + 1}: ${field} must be a non-negative number.`);
      }
    }
  });
  if (errors.length) {
    throw new PayrollDomainError(422, 'PAYROLL_INVALID', 'Payroll validation failed.', errors);
  }
}

function validateEmployeeMatches(rows) {
  const unmatched = rows.filter((row) => !row.employeeId)
    .map((row) => row.employee_code || row.employee_name || 'Unknown employee');
  if (unmatched.length) {
    throw new PayrollDomainError(
      422,
      'PAYROLL_EMPLOYEE_NOT_FOUND',
      'Every payroll row must match an employee.',
      unmatched
    );
  }
}

module.exports = { validateRows, validateEmployeeMatches, NUMERIC_FIELDS };
