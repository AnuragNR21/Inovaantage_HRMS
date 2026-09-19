const employeeRepository = require('../repositories/employeeRepository');
const { sendJson, sendError, readJsonBody } = require('../utils/http');
const auditService = require('../services/auditService');

function createEmployeeController(dependencies = {}) {
  const repository = dependencies.employeeRepository || employeeRepository;
  const audit = dependencies.auditService || auditService;

  function validateEmployeePayload(body) {
    const errors = [];
    if (!body.employeeCode || !String(body.employeeCode).trim()) errors.push('Employee Code is required.');
    if (!body.fullName || !String(body.fullName).trim()) errors.push('Full Name is required.');
    return errors;
  }

  async function listEmployees(req, res, query) {
    try { return sendJson(res, 200, { success: true, employees: await repository.list(query) }); }
    catch (err) { console.error('[employees] list error', err); return sendError(res, 500, 'Failed to fetch employees.'); }
  }

  async function getEmployee(req, res, id) {
    try {
      const employeeId = req.dataScope && req.dataScope.type === 'SELF' ? req.dataScope.employeeId : null;
      const employee = await repository.getById(id, employeeId);
      if (!employee) return sendError(res, 404, 'Employee not found.');
      return sendJson(res, 200, { success: true, employee });
    } catch (err) { console.error('[employees] get error', err); return sendError(res, 500, 'Failed to fetch employee.'); }
  }

  async function createEmployee(req, res) {
    let body;
    try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message); }
    const errors = validateEmployeePayload(body);
    if (errors.length) return sendError(res, 400, errors.join(' '));
    try {
      const result = await repository.create(body);
      const employeeId = result.outBinds.newId[0];
      await audit.record({ actorUserId: req.session.userId, action: 'EMPLOYEE_CREATED', resourceType: 'EMPLOYEE', resourceId: employeeId, metadata: { employeeCode: body.employeeCode, fields: Object.keys(body) } });
      return sendJson(res, 201, { success: true, employeeId });
    } catch (err) {
      console.error('[employees] create error', err);
      if (err.errorNum === 1) return sendError(res, 409, 'An employee with this Employee Code already exists.');
      return sendError(res, 500, 'Failed to create employee.');
    }
  }

  async function updateEmployee(req, res, id) {
    let body;
    try { body = await readJsonBody(req); } catch (err) { return sendError(res, 400, err.message); }
    const errors = validateEmployeePayload(body);
    if (errors.length) return sendError(res, 400, errors.join(' '));
    try {
      const result = await repository.update(id, body);
      if (result.rowsAffected === 0) return sendError(res, 404, 'Employee not found.');
      await audit.record({ actorUserId: req.session.userId, action: 'EMPLOYEE_MODIFIED', resourceType: 'EMPLOYEE', resourceId: id, metadata: { fields: Object.keys(body) } });
      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[employees] update error', err);
      if (err.errorNum === 1) return sendError(res, 409, 'Another employee already uses this Employee Code.');
      return sendError(res, 500, 'Failed to update employee.');
    }
  }

  async function deleteEmployee(req, res, id, cascade) {
    try {
      const result = cascade ? await repository.removeWithPayroll(id) : await repository.remove(id);
      if (result.rowsAffected === 0) return sendError(res, 404, 'Employee not found.');
      await audit.record({ actorUserId: req.session.userId, action: 'EMPLOYEE_DELETED', resourceType: 'EMPLOYEE', resourceId: id, metadata: { cascade: Boolean(cascade) } });
      return sendJson(res, 200, { success: true });
    } catch (err) {
      console.error('[employees] delete error', err);
      if (!cascade && err.errorNum === 2292) return sendError(res, 409, 'Cannot delete: this employee has payroll records. Remove those first.');
      return sendError(res, 500, cascade ? 'Failed to delete employee and payroll records.' : 'Failed to delete employee.');
    }
  }

  return { listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee };
}

module.exports = createEmployeeController();
module.exports.createEmployeeController = createEmployeeController;
