-- ============================================================
-- Seed data for Inovaantage Payroll Portal
-- Run AFTER 01_schema.sql
-- ============================================================

-- Portal users are intentionally not seeded. Create the first administrator
-- with ADMIN_USERNAME and ADMIN_PASSWORD through `npm run bootstrap-admin`.

-- Sample employees (matches the sample payslip provided: INV-011 Ananya Patnaik)
INSERT INTO employees (employee_code, full_name, department, designation, email, phone, date_of_joining, bank_account, bank_name, ifsc_code, status)
VALUES ('INV-011', 'Ananya Patnaik', 'Human Resources', 'HR Manager', 'ananya.patnaik@inovaantage.com', '9876543210', DATE '2023-04-10', '50100234567890', 'HDFC Bank', 'HDFC0001234', 'ACTIVE');

INSERT INTO employees (employee_code, full_name, department, designation, email, phone, date_of_joining, bank_account, bank_name, ifsc_code, status)
VALUES ('INV-001', 'Debiprasanna Sahoo', 'Engineering', 'Software Engineer', 'debiprasanna@inovaantage.com', '9876500001', DATE '2025-12-01', '50100111122233', 'SBI Bank', 'SBIN0005678', 'ACTIVE');

INSERT INTO employees (employee_code, full_name, department, designation, email, phone, date_of_joining, bank_account, bank_name, ifsc_code, status)
VALUES ('INV-005', 'Rohit Mishra', 'Engineering', 'iOS Developer', 'rohit.mishra@inovaantage.com', '9876500005', DATE '2024-06-15', '50100444455566', 'ICICI Bank', 'ICIC0007890', 'ACTIVE');

-- Sample payroll record matching the sample payslip PDF (July 2026)
INSERT INTO payroll (
    employee_id, employee_code, pay_month, pay_year,
    working_days, present_days, absent_days, paid_leave_days, lop_days, half_days, late_marks, ot_hours,
    basic_salary, hra, da, conveyance, medical_allowance, special_allowance, bonus, other_earnings, total_earnings,
    provident_fund, professional_tax, income_tax, other_deductions, total_deductions,
    net_salary, source_file
)
SELECT employee_id, 'INV-011', 7, 2026,
    23, 22, 0, 1, 0, 0, 2, 4.5,
    32000, 12800, 3200, 1600, 1250, 4500, 2000, 0, 57350,
    3840, 200, 1800, 0, 5840,
    51510, 'Sample_Payslip_New_Template.pdf'
FROM employees WHERE employee_code = 'INV-011';

COMMIT;
