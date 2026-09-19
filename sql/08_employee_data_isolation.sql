-- Additive, idempotent permissions for employee self-service data isolation.
DECLARE
  PROCEDURE put_permission(p_code VARCHAR2, p_description VARCHAR2) IS
  BEGIN
    MERGE INTO auth_permissions p USING (SELECT p_code code FROM dual) s ON (p.permission_code = s.code)
    WHEN MATCHED THEN UPDATE SET p.description = p_description, p.is_active = 1
    WHEN NOT MATCHED THEN INSERT (permission_code, description) VALUES (p_code, p_description);
  END;
  PROCEDURE grant_permission(p_role VARCHAR2, p_permission VARCHAR2) IS
  BEGIN
    INSERT INTO auth_role_permissions (role_id, permission_id)
    SELECT r.role_id, p.permission_id FROM auth_roles r CROSS JOIN auth_permissions p
     WHERE r.role_code = p_role AND p.permission_code = p_permission
       AND NOT EXISTS (SELECT 1 FROM auth_role_permissions rp
                        WHERE rp.role_id = r.role_id AND rp.permission_id = p.permission_id);
  END;
BEGIN
  put_permission('EMPLOYEE_SELF_VIEW', 'View the employee profile linked to the current account.');
  put_permission('SALARY_SELF_VIEW', 'View salary values belonging to the current employee.');
  put_permission('PAYROLL_SELF_VIEW', 'View payroll history belonging to the current employee.');
  put_permission('PAYSLIP_SELF_VIEW', 'View payslip metadata belonging to the current employee.');
  put_permission('PAYSLIP_SELF_DOWNLOAD', 'Download payslips belonging to the current employee.');

  grant_permission('EMPLOYEE', 'EMPLOYEE_SELF_VIEW');
  grant_permission('EMPLOYEE', 'SALARY_SELF_VIEW');
  grant_permission('EMPLOYEE', 'PAYROLL_SELF_VIEW');
  grant_permission('EMPLOYEE', 'PAYSLIP_SELF_VIEW');
  grant_permission('EMPLOYEE', 'PAYSLIP_SELF_DOWNLOAD');
END;
/

COMMIT;
