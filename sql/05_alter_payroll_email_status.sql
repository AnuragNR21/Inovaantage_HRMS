ALTER TABLE payroll ADD (
  email_status   VARCHAR2(20),   -- NULL = never sent, 'SENT', 'FAILED', 'SKIPPED'
  email_sent_at  TIMESTAMP,
  email_error    VARCHAR2(500)
);

COMMIT;
