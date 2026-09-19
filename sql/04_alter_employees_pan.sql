-- ============================================================
-- Migration: add PAN card column to EMPLOYEES
-- ============================================================
DECLARE
  v_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM user_tab_columns
   WHERE table_name = 'EMPLOYEES'
     AND column_name = 'PAN_NO';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE employees ADD (pan_no VARCHAR2(10))';
  END IF;
END;
/
