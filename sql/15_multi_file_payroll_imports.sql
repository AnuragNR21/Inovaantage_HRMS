-- Track the source import for every payroll row and allow multiple files to
-- contribute to one editable monthly payroll run.
DECLARE
  v_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM user_tab_columns
   WHERE table_name = 'PAYROLL' AND column_name = 'IMPORT_ID';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE payroll ADD (import_id NUMBER)';
  END IF;

  SELECT COUNT(*) INTO v_count FROM user_tab_columns
   WHERE table_name = 'UPLOAD_BATCHES' AND column_name = 'IMPORT_ID';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE upload_batches ADD (import_id NUMBER)';
  END IF;

  SELECT COUNT(*) INTO v_count FROM user_constraints
   WHERE constraint_name = 'FK_PAYROLL_IMPORT_SOURCE';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE payroll ADD CONSTRAINT fk_payroll_import_source FOREIGN KEY (import_id) REFERENCES payroll_imports(import_id)';
  END IF;

  SELECT COUNT(*) INTO v_count FROM user_constraints
   WHERE constraint_name = 'FK_UPLOAD_BATCH_IMPORT';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE upload_batches ADD CONSTRAINT fk_upload_batch_import FOREIGN KEY (import_id) REFERENCES payroll_imports(import_id)';
  END IF;

  SELECT COUNT(*) INTO v_count FROM user_indexes
   WHERE index_name = 'IDX_PAYROLL_IMPORT_SOURCE';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE INDEX idx_payroll_import_source ON payroll (import_id)';
  END IF;

  SELECT COUNT(*) INTO v_count FROM user_indexes
   WHERE index_name = 'IDX_UPLOAD_BATCH_IMPORT';
  IF v_count = 0 THEN
    EXECUTE IMMEDIATE 'CREATE INDEX idx_upload_batch_import ON upload_batches (import_id)';
  END IF;

  SELECT COUNT(*) INTO v_count FROM user_constraints
   WHERE constraint_name = 'CK_PAYROLL_IMPORT_STATUS';
  IF v_count = 1 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE payroll_imports DROP CONSTRAINT ck_payroll_import_status';
  END IF;
  EXECUTE IMMEDIATE q'[ALTER TABLE payroll_imports ADD CONSTRAINT ck_payroll_import_status CHECK (status IN ('PENDING','FAILED','IMPORTED','EXPIRED','DELETED'))]';
END;
/

UPDATE payroll p
   SET import_id = (SELECT r.import_id FROM payroll_runs r WHERE r.run_id = p.run_id)
 WHERE p.import_id IS NULL
   AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = p.run_id AND r.import_id IS NOT NULL);

UPDATE upload_batches b
   SET import_id = (SELECT r.import_id FROM payroll_runs r WHERE r.run_id = b.run_id)
 WHERE b.import_id IS NULL
   AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.run_id = b.run_id AND r.import_id IS NOT NULL);

COMMIT;
