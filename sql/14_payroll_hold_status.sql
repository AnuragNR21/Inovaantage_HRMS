-- Adds a governed HOLD state for finalized payroll availability.
DECLARE
  v_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM user_constraints
   WHERE table_name = 'PAYROLL_RUNS' AND constraint_name = 'CK_PAYROLL_RUN_STATUS';
  IF v_count = 1 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE payroll_runs DROP CONSTRAINT ck_payroll_run_status';
  END IF;
  EXECUTE IMMEDIATE q'[ALTER TABLE payroll_runs ADD CONSTRAINT ck_payroll_run_status
    CHECK (status IN ('DRAFT','PROCESSING','VALIDATED','APPROVED','FINALIZED','HOLD','FAILED'))]';
END;
/
COMMIT;
