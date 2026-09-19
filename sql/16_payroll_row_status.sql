-- Add employee-level approval/finalization/hold status to payroll rows.
DECLARE
  v_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM user_tab_columns
   WHERE table_name = 'PAYROLL' AND column_name = 'APPROVAL_STATUS';

  IF v_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE payroll ADD (approval_status VARCHAR2(20) DEFAULT 'VALIDATED' NOT NULL)]';
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM user_constraints
   WHERE constraint_name = 'CK_PAYROLL_APPROVAL_STATUS';

  IF v_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE payroll ADD CONSTRAINT ck_payroll_approval_status
      CHECK (approval_status IN ('VALIDATED','APPROVED','FINALIZED','HOLD'))]';
  END IF;

  SELECT COUNT(*) INTO v_count
    FROM user_indexes
   WHERE index_name = 'IDX_PAYROLL_APPROVAL_STATUS';

  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE INDEX idx_payroll_approval_status ON payroll (run_id, approval_status)';
  END IF;
END;
/

UPDATE payroll p
   SET approval_status = (
     SELECT CASE r.status
              WHEN 'FINALIZED' THEN 'FINALIZED'
              WHEN 'HOLD' THEN 'HOLD'
              WHEN 'APPROVED' THEN 'APPROVED'
              ELSE 'VALIDATED'
            END
       FROM payroll_runs r
      WHERE r.run_id = p.run_id
   )
 WHERE EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = p.run_id);

COMMIT;
