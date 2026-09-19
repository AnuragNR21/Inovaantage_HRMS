const INSERT_PAYROLL_SQL = `
  INSERT INTO payroll
    (run_id, import_id, employee_id, employee_code, pay_month, pay_year,
     working_days, present_days, absent_days, paid_leave_days, lop_days, half_days,
     late_marks, ot_hours, basic_salary, hra, da, conveyance, medical_allowance,
     special_allowance, professional_development, other_allowance, food_allowance,
     bonus, other_earnings, total_earnings, employer_contribution, lop_amount,
     gross_salary, provident_fund, esi, professional_tax, income_tax,
     other_deductions, total_deductions, net_salary, remarks, source_file)
  VALUES
    (:runId, :importId, :employeeId, :employeeCode, :payMonth, :payYear,
     :workingDays, :presentDays, :absentDays, :paidLeaveDays, :lopDays, :halfDays,
     :lateMarks, :otHours, :basicSalary, :hra, :da, :conveyance, :medicalAllowance,
     :specialAllowance, :professionalDevelopment, :otherAllowance, :foodAllowance,
     :bonus, :otherEarnings, :totalEarnings, :employerContribution, :lopAmount,
     :grossSalary, :providentFund, :esi, :professionalTax, :incomeTax,
     :otherDeductions, :totalDeductions, :netSalary, :remarks, :sourceFile)`;

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getEmployeeMatchIndex(conn) {
  const result = await conn.execute(
    `SELECT employee_id, employee_code, full_name FROM employees WHERE status = 'ACTIVE'`
  );
  const byCode = new Map();
  const byName = new Map();
  for (const row of result.rows) {
    const employee = {
      employeeId: row.EMPLOYEE_ID,
      employeeCode: row.EMPLOYEE_CODE,
      fullName: row.FULL_NAME
    };
    byCode.set(String(row.EMPLOYEE_CODE).trim().toLowerCase(), employee);
    const nameKey = normalizeName(row.FULL_NAME);
    byName.set(nameKey, byName.has(nameKey) ? null : employee);
  }
  return { byCode, byName };
}

function matchEmployee(index, row) {
  if (row.employee_code) {
    const match = index.byCode.get(String(row.employee_code).trim().toLowerCase());
    if (match) return match;
  }
  if (row.employee_name) return index.byName.get(normalizeName(row.employee_name)) || null;
  return null;
}

function payrollBinds(run, row) {
  return {
    runId: run.runId, importId: run.importId || null,
    employeeId: row.employeeId, employeeCode: row.employeeCode,
    payMonth: run.payMonth, payYear: run.payYear,
    workingDays: row.working_days, presentDays: row.present_days, absentDays: row.absent_days,
    paidLeaveDays: row.paid_leave_days, lopDays: row.lop_days, halfDays: row.half_days,
    lateMarks: row.late_marks, otHours: row.ot_hours, basicSalary: row.basic_salary,
    hra: row.hra, da: row.da, conveyance: row.conveyance,
    medicalAllowance: row.medical_allowance, specialAllowance: row.special_allowance,
    professionalDevelopment: row.professional_development, otherAllowance: row.other_allowance,
    foodAllowance: row.food_allowance, bonus: row.bonus, otherEarnings: row.other_earnings,
    totalEarnings: row.total_earnings, employerContribution: row.employer_contribution,
    lopAmount: row.lop_amount, grossSalary: row.gross_salary,
    providentFund: row.provident_fund, esi: row.esi, professionalTax: row.professional_tax,
    incomeTax: row.income_tax, otherDeductions: row.other_deductions,
    totalDeductions: row.total_deductions, netSalary: row.net_salary,
    remarks: row.remarks || null, sourceFile: run.sourceFile
  };
}

async function insertPayroll(conn, run, row) {
  return conn.execute(INSERT_PAYROLL_SQL, payrollBinds(run, row));
}

async function insertUploadBatch(conn, run, actorUsername) {
  await conn.execute(
    `INSERT INTO upload_batches
      (run_id, import_id, file_name, pay_month, pay_year, total_rows, matched_rows,
       unmatched_rows, unmatched_codes, uploaded_by)
     VALUES (:runId, :importId, :sourceFile, :payMonth, :payYear, :totalRows,
             :matchedRows, 0, NULL, :uploadedBy)`,
    {
      runId: run.runId,
      importId: run.importId || null,
      sourceFile: run.sourceFile,
      payMonth: run.payMonth,
      payYear: run.payYear,
      totalRows: run.totalRows,
      matchedRows: run.totalRows,
      uploadedBy: actorUsername
    }
  );
}

async function deleteByRun(conn, runId) {
  return conn.execute(`DELETE FROM payroll WHERE run_id = :runId`, { runId });
}

async function findPeriodConflicts(conn, payMonth, payYear, employeeIds, forUpdate = false) {
  if (!employeeIds.length) return [];
  const binds = { payMonth, payYear };
  const placeholders = employeeIds.map((employeeId, index) => {
    binds[`employee${index}`] = employeeId;
    return `:employee${index}`;
  });
  const result = await conn.execute(
    `SELECT p.payroll_id, p.employee_id, p.employee_code, e.full_name,
            p.total_earnings, p.total_deductions, p.net_salary, p.source_file,
            p.import_id
       FROM payroll p JOIN employees e ON e.employee_id = p.employee_id
      WHERE p.pay_month = :payMonth AND p.pay_year = :payYear
        AND p.employee_id IN (${placeholders.join(',')})${forUpdate ? ' FOR UPDATE' : ''}`,
    binds
  );
  return result.rows;
}

async function deleteByPayrollIds(conn, payrollIds) {
  if (!payrollIds.length) return 0;
  const binds = {};
  const placeholders = payrollIds.map((payrollId, index) => {
    binds[`payroll${index}`] = payrollId;
    return `:payroll${index}`;
  });
  const result = await conn.execute(`DELETE FROM payroll WHERE payroll_id IN (${placeholders.join(',')})`, binds);
  return result.rowsAffected;
}

async function deleteByImport(conn, importId) {
  const result = await conn.execute('DELETE FROM payroll WHERE import_id = :importId', { importId });
  return result.rowsAffected;
}

async function countByRun(conn, runId) {
  const result = await conn.execute('SELECT COUNT(*) AS row_count FROM payroll WHERE run_id = :runId', { runId });
  return Number(result.rows[0].ROW_COUNT);
}

async function deleteDeliveryArtifactsByRun(conn, runId) {
  await conn.execute('DELETE FROM payslip_email_jobs WHERE run_id = :runId', { runId });
  await conn.execute('DELETE FROM payslip_documents WHERE run_id = :runId', { runId });
}

module.exports = {
  getEmployeeMatchIndex, matchEmployee, insertPayroll, insertUploadBatch, deleteByRun,
  findPeriodConflicts, deleteByPayrollIds, deleteByImport, countByRun,
  deleteDeliveryArtifactsByRun
};
