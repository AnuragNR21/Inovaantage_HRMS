const db = require('../db');
const { applyEmployeeScope } = require('../authorization/dataScope');

async function listHistory(req, query) {
  const search = String(query.search || '').trim();
  const department = String(query.department || '').trim();
  const month = Number.parseInt(query.month, 10);
  const year = Number.parseInt(query.year, 10);
  const conditions = [];
  const binds = {};

  if (search) {
    conditions.push('(LOWER(e.employee_code) LIKE :search OR LOWER(e.full_name) LIKE :search)');
    binds.search = `%${search.toLowerCase()}%`;
  }
  if (department) {
    conditions.push('LOWER(e.department) = LOWER(:department)');
    binds.department = department;
  }
  if (month) { conditions.push('p.pay_month = :month'); binds.month = month; }
  if (year) { conditions.push('p.pay_year = :year'); binds.year = year; }
  applyEmployeeScope(req, conditions, binds, 'p.employee_id');
  if (req.dataScope && req.dataScope.type === 'SELF') conditions.push("r.status = 'FINALIZED'");
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await db.execute(
    `SELECT p.payroll_id, p.run_id, r.status AS run_status, p.approval_status,
            p.employee_code,
            e.full_name, e.department, e.designation, p.pay_month, p.pay_year,
            p.total_earnings, p.total_deductions, p.net_salary, p.uploaded_at,
            p.email_status, j.status AS email_delivery_status,
            d.status AS payslip_status
       FROM payroll p
       JOIN payroll_runs r ON r.run_id = p.run_id
       JOIN employees e ON e.employee_id = p.employee_id
       LEFT JOIN payslip_documents d ON d.payroll_id = p.payroll_id
       LEFT JOIN payslip_email_jobs j ON j.payroll_id = p.payroll_id
       ${whereClause}
       ORDER BY p.pay_year DESC, p.pay_month DESC, e.employee_code`,
    binds
  );
  return result.rows;
}

async function dashboardSummary() {
  const [empCount, activeCount, payrollCount, latestPeriod, deptBreakdown] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS cnt FROM employees`),
    db.execute(`SELECT COUNT(*) AS cnt FROM employees WHERE status = 'ACTIVE'`),
    db.execute(`SELECT COUNT(*) AS cnt FROM payroll p JOIN payroll_runs r ON r.run_id = p.run_id WHERE r.status = 'FINALIZED'`),
    db.execute(`SELECT p.pay_month, p.pay_year, COUNT(*) AS cnt, SUM(p.net_salary) AS total
                  FROM payroll p JOIN payroll_runs r ON r.run_id = p.run_id
                 WHERE r.status = 'FINALIZED'
                   AND p.pay_year = (SELECT MAX(p2.pay_year) FROM payroll p2 JOIN payroll_runs r2 ON r2.run_id = p2.run_id WHERE r2.status = 'FINALIZED')
                   AND p.pay_month = (SELECT MAX(p3.pay_month) FROM payroll p3 JOIN payroll_runs r3 ON r3.run_id = p3.run_id
                                       WHERE r3.status = 'FINALIZED' AND p3.pay_year = p.pay_year)
                 GROUP BY p.pay_month, p.pay_year`),
    db.execute(`SELECT department, COUNT(*) AS cnt FROM employees GROUP BY department`)
  ]);
  return {
    totalEmployees: empCount.rows[0].CNT,
    activeEmployees: activeCount.rows[0].CNT,
    totalPayrollRecords: payrollCount.rows[0].CNT,
    latestPeriod: latestPeriod.rows[0] || null,
    departmentBreakdown: deptBreakdown.rows
  };
}

async function listPayslips(req, query) {
  const search = String(query.search || '').trim();
  const month = Number.parseInt(query.month, 10);
  const year = Number.parseInt(query.year, 10);
  const conditions = ["r.status = 'FINALIZED'", "p.approval_status = 'FINALIZED'", "d.status = 'GENERATED'"];
  const binds = {};
  if (search) {
    conditions.push('(LOWER(e.employee_code) LIKE :search OR LOWER(e.full_name) LIKE :search)');
    binds.search = `%${search.toLowerCase()}%`;
  }
  if (month) { conditions.push('p.pay_month = :month'); binds.month = month; }
  if (year) { conditions.push('p.pay_year = :year'); binds.year = year; }
  applyEmployeeScope(req, conditions, binds, 'p.employee_id');
  const result = await db.execute(
    `SELECT p.payroll_id, p.run_id, p.employee_code, e.full_name, e.department,
            p.pay_month, p.pay_year, p.net_salary, d.status AS payslip_status,
            d.generated_at, j.status AS email_delivery_status
       FROM payroll p
       JOIN payroll_runs r ON r.run_id = p.run_id
       JOIN employees e ON e.employee_id = p.employee_id
       JOIN payslip_documents d ON d.payroll_id = p.payroll_id
       LEFT JOIN payslip_email_jobs j ON j.payroll_id = p.payroll_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.pay_year DESC, p.pay_month DESC, e.employee_code`,
    binds
  );
  return result.rows;
}

async function listRunReports() {
  const result = await db.execute(
    `SELECT r.run_id, r.pay_month, r.pay_year, r.status, r.created_at,
            r.finalized_at, r.updated_at, COUNT(p.payroll_id) AS employee_count,
            NVL(SUM(p.total_earnings), 0) AS total_earnings,
            NVL(SUM(p.total_deductions), 0) AS total_deductions,
            NVL(SUM(p.net_salary), 0) AS net_salary,
            SUM(CASE WHEN d.status = 'GENERATED' THEN 1 ELSE 0 END) AS generated_payslips,
            SUM(CASE WHEN j.status = 'SENT' THEN 1 ELSE 0 END) AS emails_sent
       FROM payroll_runs r
       LEFT JOIN payroll p ON p.run_id = r.run_id
       LEFT JOIN payslip_documents d ON d.payroll_id = p.payroll_id
       LEFT JOIN payslip_email_jobs j ON j.payroll_id = p.payroll_id
      GROUP BY r.run_id, r.pay_month, r.pay_year, r.status, r.created_at,
               r.finalized_at, r.updated_at
      ORDER BY r.pay_year DESC, r.pay_month DESC, r.created_at DESC`
  );
  return result.rows;
}

async function getRunDetailReport(runId) {
  const runResult = await db.execute(
    `SELECT run_id, pay_month, pay_year, status
       FROM payroll_runs
      WHERE run_id = :runId`,
    { runId }
  );
  if (!runResult.rows.length) return null;
  const records = await db.execute(
    `SELECT p.employee_code, e.full_name AS employee_name,
            p.working_days, p.present_days, p.absent_days, p.paid_leave_days,
            p.lop_days, p.half_days, p.late_marks, p.ot_hours,
            p.basic_salary, p.hra, p.da, p.conveyance, p.medical_allowance,
            p.special_allowance, p.professional_development, p.other_allowance,
            p.food_allowance, p.bonus, p.other_earnings, p.total_earnings,
            p.employer_contribution, p.lop_amount, p.gross_salary,
            p.provident_fund, p.esi, p.professional_tax, p.income_tax,
            p.other_deductions, p.total_deductions, p.net_salary, p.remarks
       FROM payroll p
       JOIN employees e ON e.employee_id = p.employee_id
      WHERE p.run_id = :runId
      ORDER BY p.employee_code`,
    { runId }
  );
  return { run: runResult.rows[0], records: records.rows };
}

module.exports = { listHistory, listPayslips, listRunReports, getRunDetailReport, dashboardSummary };
