const authController = require('./controllers/authController');
const employeeController = require('./controllers/employeeController');
const salaryController = require('./controllers/salaryController');
const payrollController = require('./controllers/payrollController');
const payrollRunController = require('./controllers/payrollRunController');
const emailController = require('./controllers/emailController');
const userController = require('./controllers/userController');
const systemController = require('./controllers/systemController');
const { authorizeRequest } = require('./authorization/authorizeRequest');
const { sendError } = require('./utils/http');
const auditController = require('./controllers/auditController');
const { isStateChangingMethod, isSameOriginRequest } = require('./security');
const { getAuthConfig } = require('./config');

/**
 * Very small router: matches method + path pattern (supports one :id segment).
 * Returns true if the request was handled, false if no route matched.
 */
async function routeApi(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);
  const method = req.method;

  if (!pathname.startsWith('/api/')) return false;

  if (isStateChangingMethod(method) && !isSameOriginRequest(req, getAuthConfig().appBaseUrl)) {
    sendError(res, 403, 'Cross-site requests are not allowed.', 'CSRF_ORIGIN_INVALID');
    return true;
  }

  // ---------- Auth (no auth required) ----------
  if (pathname === '/api/login' && method === 'POST') {
    await authController.login(req, res);
    return true;
  }
  if (pathname === '/api/password/forgot' && method === 'POST') {
    await authController.requestPasswordReset(req, res);
    return true;
  }
  if (pathname === '/api/password/reset' && method === 'POST') {
    await authController.resetPassword(req, res);
    return true;
  }
  if (pathname === '/api/logout' && method === 'POST') {
    await authController.logout(req, res);
    return true;
  }

  if (pathname === '/api/me' && method === 'GET') {
    if (!await authController.requireAuth(req, res, { allowPasswordChange: true })) return true;
    await authController.me(req, res);
    return true;
  }
  if (pathname === '/api/password/change' && method === 'POST') {
    if (!await authController.requireAuth(req, res, { allowPasswordChange: true })) return true;
    await authController.changePassword(req, res);
    return true;
  }

  // Everything below requires an authenticated session with no pending password change.
  if (!await authController.requireAuth(req, res)) return true;
  if (!await authorizeRequest(req, res, method, pathname)) return true;

  // ---------- Users and roles ----------
  if (pathname === '/api/users' && method === 'GET') {
    await userController.listUsers(req, res);
    return true;
  }
  if (pathname === '/api/users' && method === 'POST') {
    await userController.createUser(req, res);
    return true;
  }
  if (pathname === '/api/roles' && method === 'GET') {
    await userController.listRoles(req, res);
    return true;
  }
  if (pathname === '/api/system/configuration' && method === 'GET') {
    systemController.getConfiguration(req, res);
    return true;
  }
  if (pathname === '/api/audit' && method === 'GET') {
    await auditController.list(req, res, query);
    return true;
  }

  let userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && method === 'GET') {
    await userController.getUser(req, res, parseInt(userMatch[1], 10));
    return true;
  }
  if (userMatch && method === 'PUT') {
    await userController.updateUser(req, res, parseInt(userMatch[1], 10));
    return true;
  }
  userMatch = pathname.match(/^\/api\/users\/(\d+)\/deactivate$/);
  if (userMatch && method === 'POST') {
    await userController.deactivateUser(req, res, parseInt(userMatch[1], 10));
    return true;
  }
  userMatch = pathname.match(/^\/api\/users\/(\d+)\/activate$/);
  if (userMatch && method === 'POST') {
    await userController.activateUser(req, res, parseInt(userMatch[1], 10));
    return true;
  }
  userMatch = pathname.match(/^\/api\/users\/(\d+)\/roles$/);
  if (userMatch && method === 'PUT') {
    await userController.replaceRoles(req, res, parseInt(userMatch[1], 10));
    return true;
  }
  userMatch = pathname.match(/^\/api\/users\/(\d+)\/permissions$/);
  if (userMatch && method === 'PUT') {
    userController.rejectDirectPermissions(req, res);
    return true;
  }

  if (pathname === '/api/dashboard/summary' && method === 'GET') {
    await payrollController.dashboardSummary(req, res);
    return true;
  }

  // ---------- Employees ----------
  if (pathname === '/api/employees' && method === 'GET') {
    await employeeController.listEmployees(req, res, query);
    return true;
  }
  if (pathname === '/api/employees' && method === 'POST') {
    await employeeController.createEmployee(req, res);
    return true;
  }
  let m = pathname.match(/^\/api\/employees\/(\d+)$/);
  if (m && method === 'GET') {
    await employeeController.getEmployee(req, res, parseInt(m[1], 10));
    return true;
  }
  if (m && method === 'PUT') {
    await employeeController.updateEmployee(req, res, parseInt(m[1], 10));
    return true;
  }
  if (m && method === 'DELETE') {
    const cascade = query.cascade === 'true' || query.cascade === '1';
    await employeeController.deleteEmployee(req, res, parseInt(m[1], 10), cascade);
    return true;
  }

  // ---------- Salary upload ----------
  if (pathname === '/api/salary/upload' && method === 'POST') {
    await salaryController.previewSalary(req, res);
    return true;
  }
  if (pathname === '/api/salary/upload/confirm' && method === 'POST') {
    await salaryController.confirmSalary(req, res);
    return true;
  }
  if (pathname === '/api/salary/imports' && method === 'GET') {
    await salaryController.listImports(req, res);
    return true;
  }
  m = pathname.match(/^\/api\/salary\/imports\/(\d+)$/);
  if (m && method === 'DELETE') {
    await salaryController.deleteImport(req, res, parseInt(m[1], 10));
    return true;
  }

  // ---------- Payroll history / payslip ----------
  if (pathname === '/api/payroll' && method === 'GET') {
    await payrollController.listPayrollHistory(req, res, query);
    return true;
  }
  if (pathname === '/api/payroll/reports' && method === 'GET') {
    await payrollController.listPayrollReports(req, res);
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/reports\/(\d+)\/export$/);
  if (m && method === 'GET') {
    await payrollController.exportPayrollReport(req, res, parseInt(m[1], 10));
    return true;
  }
  if (pathname === '/api/payslips' && method === 'GET') {
    await payrollController.listPayslips(req, res, query);
    return true;
  }
  if (pathname === '/api/payroll/rows/approve' && method === 'POST') {
    await payrollRunController.updateRows(req, res);
    return true;
  }
  if (pathname === '/api/payroll/rows/finalize' && method === 'POST') {
    await payrollRunController.updateRows(req, res);
    return true;
  }
  if (pathname === '/api/payroll/rows/hold' && method === 'POST') {
    await payrollRunController.updateRows(req, res);
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/runs\/(\d+)\/approve$/);
  if (m && method === 'POST') {
    await payrollRunController.approve(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/runs\/(\d+)\/finalize$/);
  if (m && method === 'POST') {
    await payrollRunController.finalize(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/runs\/(\d+)\/availability$/);
  if (m && method === 'PUT') {
    await payrollRunController.updateAvailability(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/runs\/(\d+)\/payslips$/);
  if (m && method === 'GET') {
    await payrollRunController.listPayslips(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/runs\/(\d+)\/payslips\/generate$/);
  if (m && method === 'POST') {
    await payrollRunController.generatePayslips(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/runs\/(\d+)\/emails$/);
  if (m && method === 'GET') {
    await emailController.listEmailStatus(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/(\d+)\/payslip$/);
  if (m && method === 'GET') {
    await payrollController.downloadPayslip(req, res, parseInt(m[1], 10));
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/(\d+)$/);
  if (m && method === 'DELETE') {
    await payrollController.deletePayrollRecord(req, res, parseInt(m[1], 10));
    return true;
  }

  // ---------- Payslip email delivery ----------
  if (pathname === '/api/payroll/send-slips' && method === 'POST') {
    await emailController.sendSlipsForPeriod(req, res);
    return true;
  }
  m = pathname.match(/^\/api\/payroll\/(\d+)\/send-slip$/);
  if (m && method === 'POST') {
    await emailController.sendSlipForRecord(req, res, parseInt(m[1], 10));
    return true;
  }

  sendError(res, 404, 'API route not found.');
  return true;
}

module.exports = { routeApi };
