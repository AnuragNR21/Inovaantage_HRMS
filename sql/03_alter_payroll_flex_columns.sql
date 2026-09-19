-- ============================================================
-- Migration: add flexible salary-component columns to PAYROLL
-- ============================================================
DECLARE
  PROCEDURE add_col(p_name VARCHAR2, p_ddl VARCHAR2) IS
    v_count NUMBER;
  BEGIN
    SELECT COUNT(*) INTO v_count
      FROM user_tab_columns
     WHERE table_name = 'PAYROLL'
       AND column_name = UPPER(p_name);
    IF v_count = 0 THEN
      EXECUTE IMMEDIATE 'ALTER TABLE payroll ADD (' || p_ddl || ')';
    END IF;
  END;
BEGIN
  add_col('PROFESSIONAL_DEVELOPMENT', 'professional_development NUMBER(12,2) DEFAULT 0');
  add_col('OTHER_ALLOWANCE',          'other_allowance NUMBER(12,2) DEFAULT 0');
  add_col('FOOD_ALLOWANCE',           'food_allowance NUMBER(12,2) DEFAULT 0');
  add_col('EMPLOYER_CONTRIBUTION',    'employer_contribution NUMBER(12,2) DEFAULT 0');
  add_col('LOP_AMOUNT',               'lop_amount NUMBER(12,2) DEFAULT 0');
  add_col('ESI',                      'esi NUMBER(12,2) DEFAULT 0');
  add_col('GROSS_SALARY',             'gross_salary NUMBER(12,2) DEFAULT 0');
  add_col('REMARKS',                  'remarks VARCHAR2(500)');
END;
/

-- employee_code is required today (NOT NULL, UNIQUE). Company sheets that
-- only provide an employee NAME still resolve to an existing employee_id/
-- employee_code before the row is saved (see salaryController.js), so no
-- schema change is required to allow name-only uploads.

COMMIT;
