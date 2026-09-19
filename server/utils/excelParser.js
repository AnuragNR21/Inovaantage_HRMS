const XLSX = require('xlsx');
const { PayrollDomainError } = require('../domain/payroll/payrollError');

const FIELD_ALIASES = {
  employee_code: ['employeecode', 'empcode', 'employeeid', 'empid', 'code'],
  employee_name: ['particulars', 'employeename', 'empname', 'name', 'staffname', 'employee'],
  working_days: ['workingdays'], present_days: ['present', 'presentdays'],
  absent_days: ['absent', 'absentdays'], paid_leave_days: ['paidleave', 'paidleavedays', 'leave'],
  lop_days: ['lopdays'], half_days: ['halfday', 'halfdays'], late_marks: ['late', 'latemarks'],
  ot_hours: ['ot', 'othours', 'overtime'], basic_salary: ['basic', 'basicsalary'], hra: ['hra'],
  da: ['da', 'dearnessallowance'], conveyance: ['conveyance', 'conveyanceallowance'],
  medical_allowance: ['medical', 'medicalallowance'], special_allowance: ['special', 'specialallowance'],
  professional_development: ['professionaldevelopment', 'proddevelopment', 'pd'],
  other_allowance: ['otherallowance'], food_allowance: ['foodallowance'], bonus: ['bonus'],
  other_earnings: ['otherearnings', 'othearnings'], total_earnings: ['totalearnings'],
  employer_contribution: ['employercontribution'], lop_amount: ['lop'], gross_salary: ['grosssalary', 'gross'],
  provident_fund: ['pf', 'providentfund', 'epf'], esi: ['esi'],
  professional_tax: ['pt', 'professionaltax'], income_tax: ['tds', 'incometax'],
  other_deductions: ['otherdeductions', 'othdeductions'], total_deductions: ['totaldeductions'],
  net_salary: ['netsalary', 'netpay', 'takehome'], remarks: ['remarks', 'remark', 'notes', 'note']
};

const PREFIX_ALIASES = [
  ['employer_contribution', 'employercontribution'],
  ['professional_development', 'professionaldevelopment'],
  ['lop_amount', 'lop']
];
const NON_EMPLOYEE_ROW_LABELS = new Set([
  'total', 'totals', 'grandtotal', 'subtotal', 'sum', 'average', 'particulars', 'grosstotal'
]);
const NUMERIC_FIELDS = [
  'working_days', 'present_days', 'absent_days', 'paid_leave_days', 'lop_days', 'half_days',
  'late_marks', 'ot_hours', 'basic_salary', 'hra', 'da', 'conveyance', 'medical_allowance',
  'special_allowance', 'professional_development', 'other_allowance', 'food_allowance', 'bonus',
  'other_earnings', 'total_earnings', 'employer_contribution', 'lop_amount', 'gross_salary',
  'provident_fund', 'esi', 'professional_tax', 'income_tax', 'other_deductions',
  'total_deductions', 'net_salary'
];
const SALARY_FIELDS = new Set([
  'basic_salary', 'total_earnings', 'gross_salary', 'net_salary', 'hra', 'da', 'conveyance',
  'medical_allowance', 'special_allowance', 'professional_development', 'other_allowance',
  'food_allowance', 'bonus', 'other_earnings'
]);

function normalizeKey(key) {
  return String(key == null ? '' : key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildFieldLookup() {
  const lookup = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    lookup[normalizeKey(field)] = field;
    aliases.forEach((alias) => { lookup[normalizeKey(alias)] = field; });
  }
  return lookup;
}

function resolveField(rawHeader, lookup) {
  const normalized = normalizeKey(rawHeader);
  if (!normalized) return null;
  if (lookup[normalized]) return lookup[normalized];
  const prefix = PREFIX_ALIASES.find(([, candidate]) => normalized.startsWith(candidate));
  return prefix ? prefix[0] : null;
}

function pickSheet(workbook) {
  const named = workbook.SheetNames.find((name) => /salary/i.test(name) && !/leave/i.test(name));
  return named || workbook.SheetNames[0];
}

function detectHeaderRow(rows, lookup) {
  let bestRow = -1;
  let bestScore = 0;
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 25); rowIndex += 1) {
    let score = 0;
    let hasIdentifier = false;
    for (const cell of rows[rowIndex] || []) {
      const field = resolveField(cell, lookup);
      if (field) {
        score += 1;
        if (field === 'employee_code' || field === 'employee_name') hasIdentifier = true;
      }
    }
    if (hasIdentifier && score >= 2 && score > bestScore) {
      bestScore = score;
      bestRow = rowIndex;
    }
  }
  return bestRow;
}

function parseNumericValue(value) {
  if (value === undefined || value === null || value === '') return { value: 0 };
  if (value instanceof Date) return { error: 'must be a number, not a date' };
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : { error: 'must be a finite number' };
  const text = String(value).trim().replace(/,/g, '');
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
    return { error: `contains invalid salary value "${String(value).slice(0, 40)}"` };
  }
  const number = Number(text);
  return Number.isFinite(number) ? { value: number } : { error: 'must be a finite number' };
}

function workbookRange(sheet) {
  if (!sheet || (!sheet['!fullref'] && !sheet['!ref'])) return null;
  try { return XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']); } catch (err) { return null; }
}

function parseSalaryExcel(buffer, limits = {}) {
  const maxRows = limits.maxRows || 10000;
  const maxColumns = limits.maxColumns || 100;
  const maxSheets = limits.maxSheets || 10;
  const diagnosticLimit = limits.diagnosticLimit || 100;
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer', cellDates: true, cellFormula: true, bookVBA: true,
      sheetRows: maxRows + 30, WTF: false
    });
  } catch (err) {
    throw new PayrollDomainError(400, 'PAYROLL_WORKBOOK_INVALID', 'The file is not a readable Excel workbook.');
  }
  if (!workbook.SheetNames.length || workbook.SheetNames.length > maxSheets) {
    throw new PayrollDomainError(422, 'PAYROLL_WORKBOOK_STRUCTURE_INVALID', `The workbook must contain between 1 and ${maxSheets} worksheets.`);
  }
  if (workbook.vbaraw) {
    throw new PayrollDomainError(422, 'PAYROLL_WORKBOOK_MACROS_NOT_ALLOWED', 'Macro-enabled workbooks are not accepted.');
  }

  const sheetName = pickSheet(workbook);
  const sheet = workbook.Sheets[sheetName];
  const range = workbookRange(sheet);
  if (!range) throw new PayrollDomainError(422, 'PAYROLL_WORKBOOK_EMPTY', 'The selected worksheet has no data.');
  if ((range.e.c - range.s.c + 1) > maxColumns || (range.e.r - range.s.r + 1) > maxRows + 25) {
    throw new PayrollDomainError(
      413,
      'PAYROLL_WORKBOOK_LIMIT_EXCEEDED',
      `The salary worksheet may contain at most ${maxRows} data rows and ${maxColumns} columns.`
    );
  }

  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const lookup = buildFieldLookup();
  const headerRowIndex = detectHeaderRow(aoa, lookup);
  if (headerRowIndex === -1) {
    throw new PayrollDomainError(422, 'PAYROLL_SCHEMA_INVALID', 'No salary header row with an employee identifier was found.');
  }

  const headerMap = {};
  const duplicateHeaders = [];
  for (const [columnIndex, cell] of (aoa[headerRowIndex] || []).entries()) {
    const field = resolveField(cell, lookup);
    if (!field) continue;
    if (Object.values(headerMap).includes(field)) duplicateHeaders.push(field);
    else headerMap[columnIndex] = field;
  }
  const fields = Object.values(headerMap);
  const missingColumns = [];
  if (!fields.includes('employee_code') && !fields.includes('employee_name')) missingColumns.push('Employee Code or Employee Name');
  if (!fields.some((field) => SALARY_FIELDS.has(field))) missingColumns.push('at least one salary/earnings column');
  if (missingColumns.length || duplicateHeaders.length) {
    throw new PayrollDomainError(422, 'PAYROLL_SCHEMA_INVALID', 'The salary workbook schema is invalid.', {
      missingColumns,
      duplicateColumns: [...new Set(duplicateHeaders)]
    });
  }

  const rows = [];
  const rowErrors = [];
  const warnings = [];
  let totalRows = 0;
  let invalidRows = 0;
  for (let rowIndex = headerRowIndex + 1; rowIndex < aoa.length; rowIndex += 1) {
    const rawRow = aoa[rowIndex];
    if (!rawRow || rawRow.every((cell) => cell === '' || cell === null || cell === undefined)) continue;
    const rawRecord = {};
    for (const [columnIndex, field] of Object.entries(headerMap)) rawRecord[field] = rawRow[columnIndex];
    const employeeCode = String(rawRecord.employee_code || '').trim();
    const employeeName = String(rawRecord.employee_name || '').trim();
    if (NON_EMPLOYEE_ROW_LABELS.has(normalizeKey(employeeCode)) || NON_EMPLOYEE_ROW_LABELS.has(normalizeKey(employeeName))) {
      warnings.push(`Row ${rowIndex + 1}: summary row was ignored.`);
      continue;
    }

    totalRows += 1;
    const errors = [];
    if (!employeeCode && !employeeName) errors.push('employee identifier is required');
    const normalized = { employee_code: employeeCode, employee_name: employeeName, excel_row_number: rowIndex + 1 };
    for (const field of NUMERIC_FIELDS) {
      const parsed = parseNumericValue(rawRecord[field]);
      if (parsed.error) errors.push(`${field} ${parsed.error}`);
      else if (parsed.value < 0) errors.push(`${field} must be non-negative`);
      else normalized[field] = parsed.value;
    }
    normalized.remarks = rawRecord.remarks ? String(rawRecord.remarks).trim().slice(0, 500) : '';
    if (errors.length) {
      invalidRows += 1;
      if (rowErrors.length < diagnosticLimit) rowErrors.push({ row: rowIndex + 1, identifier: employeeCode || employeeName, errors });
      continue;
    }
    rows.push(normalized);
  }
  if (totalRows > maxRows) {
    throw new PayrollDomainError(413, 'PAYROLL_WORKBOOK_LIMIT_EXCEEDED', `The workbook contains more than ${maxRows} salary rows.`);
  }
  if (!totalRows) throw new PayrollDomainError(422, 'PAYROLL_WORKBOOK_EMPTY', 'The salary worksheet contains no employee rows.');

  return {
    rows, rowErrors, warnings: warnings.slice(0, diagnosticLimit), totalRows, invalidRows,
    sheetName, headerRowNumber: headerRowIndex + 1, columns: fields
  };
}

module.exports = { parseSalaryExcel, NUMERIC_FIELDS, FIELD_ALIASES };
