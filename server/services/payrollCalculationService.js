function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(row, fields) {
  return fields.reduce((total, field) => total + number(row[field]), 0);
}

function calculatePayrollRow(row) {
  const calculatedEarnings = sum(row, [
    'basic_salary', 'hra', 'da', 'conveyance', 'medical_allowance',
    'special_allowance', 'professional_development', 'other_allowance',
    'food_allowance', 'bonus', 'other_earnings'
  ]);
  const totalEarnings = number(row.total_earnings) || calculatedEarnings;
  const grossSalary = number(row.gross_salary) ||
    Math.max(0, totalEarnings - number(row.employer_contribution) - number(row.lop_amount));
  const calculatedDeductions = sum(row, [
    'provident_fund', 'esi', 'professional_tax', 'income_tax', 'other_deductions'
  ]);
  const totalDeductions = number(row.total_deductions) || calculatedDeductions;
  const netSalary = number(row.net_salary) || Math.max(0, grossSalary - totalDeductions);
  return {
    ...row,
    total_earnings: totalEarnings,
    gross_salary: grossSalary,
    total_deductions: totalDeductions,
    net_salary: netSalary
  };
}

module.exports = { calculatePayrollRow };
