const { PERMISSIONS: P } = require('./permissions');

const policies = [
  ['GET', /^\/api\/dashboard\/summary$/, [P.DASHBOARD_VIEW]],

  ['GET', /^\/api\/users$/, [P.USER_VIEW]],
  ['POST', /^\/api\/users$/, [P.USER_CREATE, P.ROLE_ASSIGN]],
  ['GET', /^\/api\/users\/\d+$/, [P.USER_VIEW]],
  ['PUT', /^\/api\/users\/\d+$/, [P.USER_UPDATE]],
  ['POST', /^\/api\/users\/\d+\/deactivate$/, [P.USER_DEACTIVATE]],
  ['POST', /^\/api\/users\/\d+\/activate$/, [P.USER_DEACTIVATE]],
  ['DELETE', /^\/api\/users\/\d+$/, [P.USER_DELETE]],
  ['PUT', /^\/api\/users\/\d+\/roles$/, [P.USER_UPDATE, P.ROLE_ASSIGN]],
  ['PUT', /^\/api\/users\/\d+\/permissions$/, [P.SYSTEM_CONFIGURE]],
  ['GET', /^\/api\/roles$/, [P.ROLE_VIEW]],
  ['GET', /^\/api\/system\/configuration$/, [P.SYSTEM_CONFIGURE]],
  ['GET', /^\/api\/audit$/, [P.AUDIT_VIEW]],

  ['GET', /^\/api\/employees$/, [P.EMPLOYEE_VIEW]],
  ['POST', /^\/api\/employees$/, [P.EMPLOYEE_CREATE]],
  ['GET', /^\/api\/employees\/\d+$/, { alternatives: [
    { scope: 'ALL', permissions: [P.EMPLOYEE_VIEW] },
    { scope: 'SELF', permissions: [P.EMPLOYEE_SELF_VIEW] }
  ] }],
  ['PUT', /^\/api\/employees\/\d+$/, [P.EMPLOYEE_UPDATE]],
  ['DELETE', /^\/api\/employees\/\d+$/, [P.EMPLOYEE_DELETE]],

  ['POST', /^\/api\/salary\/upload$/, [P.PAYROLL_UPLOAD, P.PAYROLL_PROCESS, P.SALARY_UPDATE]],
  ['POST', /^\/api\/salary\/upload\/confirm$/, [P.PAYROLL_UPLOAD, P.PAYROLL_PROCESS, P.SALARY_UPDATE]],
  ['GET', /^\/api\/salary\/imports$/, [P.PAYROLL_UPLOAD, P.PAYROLL_PROCESS]],
  ['DELETE', /^\/api\/salary\/imports\/\d+$/, [P.PAYROLL_UPLOAD, P.PAYROLL_PROCESS, P.PAYROLL_DELETE]],
  ['PUT', /^\/api\/payroll\/\d+$/, [P.SALARY_UPDATE]],
  ['GET', /^\/api\/payroll$/, { alternatives: [
    { scope: 'ALL', permissions: [P.PAYROLL_VIEW, P.SALARY_VIEW] },
    { scope: 'SELF', permissions: [P.PAYROLL_SELF_VIEW, P.SALARY_SELF_VIEW] }
  ] }],
  ['GET', /^\/api\/payroll\/reports$/, [P.PAYROLL_VIEW, P.SALARY_VIEW]],
  ['GET', /^\/api\/payroll\/reports\/\d+\/export$/, [P.PAYROLL_VIEW, P.SALARY_VIEW]],
  ['GET', /^\/api\/payslips$/, { alternatives: [
    { scope: 'ALL', permissions: [P.PAYSLIP_VIEW] },
    { scope: 'SELF', permissions: [P.PAYSLIP_SELF_VIEW] }
  ] }],
  ['DELETE', /^\/api\/payroll\/\d+$/, [P.PAYROLL_DELETE]],
  ['POST', /^\/api\/payroll\/\d+\/process$/, [P.PAYROLL_PROCESS]],
  ['POST', /^\/api\/payroll\/runs\/\d+\/approve$/, [P.PAYROLL_APPROVE]],
  ['POST', /^\/api\/payroll\/runs\/\d+\/finalize$/, [P.PAYROLL_FINALIZE]],
  ['PUT', /^\/api\/payroll\/runs\/\d+\/availability$/, [P.PAYROLL_FINALIZE]],
  ['POST', /^\/api\/payroll\/rows\/approve$/, [P.PAYROLL_APPROVE]],
  ['POST', /^\/api\/payroll\/rows\/finalize$/, [P.PAYROLL_FINALIZE]],
  ['POST', /^\/api\/payroll\/rows\/hold$/, [P.PAYROLL_FINALIZE]],
  ['POST', /^\/api\/payroll\/rows\/delete$/, [P.PAYROLL_DELETE]],
  ['GET', /^\/api\/payroll\/runs\/\d+\/payslips$/, [P.PAYSLIP_VIEW]],
  ['POST', /^\/api\/payroll\/runs\/\d+\/payslips\/generate$/, [P.PAYSLIP_GENERATE]],
  ['GET', /^\/api\/payroll\/runs\/\d+\/emails$/, [P.PAYSLIP_EMAIL]],
  ['POST', /^\/api\/payroll\/\d+\/reverse$/, [P.PAYROLL_REVERSE]],
  ['GET', /^\/api\/payroll\/\d+\/payslip$/, { alternatives: [
    { scope: 'ALL', permissions: [P.PAYSLIP_VIEW, P.PAYSLIP_DOWNLOAD] },
    { scope: 'SELF', permissions: [P.PAYSLIP_SELF_VIEW, P.PAYSLIP_SELF_DOWNLOAD] }
  ] }],
  ['POST', /^\/api\/payroll\/send-slips$/, [P.PAYSLIP_EMAIL]],
  ['POST', /^\/api\/payroll\/\d+\/send-slip$/, [P.PAYSLIP_EMAIL]]
];

function permissionsForRequest(method, pathname) {
  const match = policies.find(([policyMethod, pattern]) => policyMethod === method && pattern.test(pathname));
  return match ? match[2] : null;
}

module.exports = { policies, permissionsForRequest };
