const COLUMNS = [
  ['Employee Code', 'EMPLOYEE_CODE'], ['Employee Name', 'EMPLOYEE_NAME'],
  ['Working Days', 'WORKING_DAYS'], ['Present Days', 'PRESENT_DAYS'],
  ['Absent Days', 'ABSENT_DAYS'], ['Paid Leave Days', 'PAID_LEAVE_DAYS'],
  ['LOP Days', 'LOP_DAYS'], ['Half Days', 'HALF_DAYS'],
  ['Late Marks', 'LATE_MARKS'], ['OT Hours', 'OT_HOURS'],
  ['Basic Salary', 'BASIC_SALARY'], ['HRA', 'HRA'], ['DA', 'DA'],
  ['Conveyance', 'CONVEYANCE'], ['Medical Allowance', 'MEDICAL_ALLOWANCE'],
  ['Special Allowance', 'SPECIAL_ALLOWANCE'],
  ['Professional Development', 'PROFESSIONAL_DEVELOPMENT'],
  ['Other Allowance', 'OTHER_ALLOWANCE'], ['Food Allowance', 'FOOD_ALLOWANCE'],
  ['Bonus', 'BONUS'], ['Other Earnings', 'OTHER_EARNINGS'],
  ['Total Earnings', 'TOTAL_EARNINGS'], ['Employer Contribution', 'EMPLOYER_CONTRIBUTION'],
  ['LOP Amount', 'LOP_AMOUNT'], ['Gross Salary', 'GROSS_SALARY'],
  ['Provident Fund', 'PROVIDENT_FUND'], ['ESI', 'ESI'],
  ['Professional Tax', 'PROFESSIONAL_TAX'], ['Income Tax', 'INCOME_TAX'],
  ['Other Deductions', 'OTHER_DEDUCTIONS'], ['Total Deductions', 'TOTAL_DEDUCTIONS'],
  ['Net Salary', 'NET_SALARY'], ['Remarks', 'REMARKS']
];

function safeSpreadsheetValue(value) {
  if (value == null) return '';
  if (typeof value === 'number') return value;
  const text = String(value);
  return /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  return `"${String(safeSpreadsheetValue(value)).replace(/"/g, '""')}"`;
}

function buildPayrollDetailCsv(records) {
  const rows = [COLUMNS.map(([heading]) => heading)];
  for (const record of records) rows.push(COLUMNS.map(([, field]) => record[field]));
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

module.exports = { buildPayrollDetailCsv };
