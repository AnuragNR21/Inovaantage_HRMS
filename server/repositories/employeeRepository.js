const db = require('../db');

function buildFilters(query = {}) {
  const conditions = [];
  const binds = {};
  const search = String(query.search || '').trim();
  const department = String(query.department || '').trim();
  const status = String(query.status || '').trim();
  if (search) { conditions.push('(LOWER(employee_code) LIKE :search OR LOWER(full_name) LIKE :search)'); binds.search = `%${search.toLowerCase()}%`; }
  if (department) { conditions.push('LOWER(department) = LOWER(:department)'); binds.department = department; }
  if (status) { conditions.push('status = :status'); binds.status = status.toUpperCase(); }
  return { conditions, binds };
}

async function list(query = {}) {
  const { conditions, binds } = buildFilters(query);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.execute(
    `SELECT employee_id, employee_code, full_name, department, designation, email, phone,
            date_of_joining, bank_account, bank_name, ifsc_code, pan_no, status
       FROM employees ${where} ORDER BY employee_code`,
    binds
  );
  return result.rows;
}

async function getById(id, employeeId = null) {
  const conditions = ['employee_id = :id'];
  const binds = { id };
  if (employeeId != null) { conditions.push('employee_id = :employeeId'); binds.employeeId = employeeId; }
  const result = await db.execute(
    `SELECT employee_id, employee_code, full_name, department, designation, email, phone,
            date_of_joining, bank_account, bank_name, ifsc_code, pan_no, status
       FROM employees WHERE ${conditions.join(' AND ')}`,
    binds
  );
  return result.rows[0] || null;
}

function employeeBinds(payload, id) {
  return {
    employeeCode: String(payload.employeeCode).trim(), fullName: String(payload.fullName).trim(),
    department: payload.department || null, designation: payload.designation || null,
    email: payload.email || null, phone: payload.phone || null, doj: payload.dateOfJoining || null,
    bankAccount: payload.bankAccount || null, bankName: payload.bankName || null,
    ifscCode: payload.ifscCode || null, panNo: payload.panNo ? String(payload.panNo).trim().toUpperCase() : null,
    status: (payload.status || 'ACTIVE').toUpperCase(), ...(id == null ? {} : { id })
  };
}

async function create(payload) {
  return db.execute(
    `INSERT INTO employees
      (employee_code, full_name, department, designation, email, phone, date_of_joining,
       bank_account, bank_name, ifsc_code, pan_no, status)
     VALUES (:employeeCode, :fullName, :department, :designation, :email, :phone,
       CASE WHEN :doj IS NULL THEN NULL ELSE TO_DATE(:doj, 'YYYY-MM-DD') END,
       :bankAccount, :bankName, :ifscCode, :panNo, :status)
     RETURNING employee_id INTO :newId`,
    { ...employeeBinds(payload), newId: { dir: db.oracledb.BIND_OUT, type: db.oracledb.NUMBER } }, {}, true
  );
}

async function update(id, payload) {
  return db.execute(
    `UPDATE employees SET employee_code = :employeeCode, full_name = :fullName,
       department = :department, designation = :designation, email = :email, phone = :phone,
       date_of_joining = CASE WHEN :doj IS NULL THEN NULL ELSE TO_DATE(:doj, 'YYYY-MM-DD') END,
       bank_account = :bankAccount, bank_name = :bankName, ifsc_code = :ifscCode,
       pan_no = :panNo, status = :status, updated_at = SYSTIMESTAMP WHERE employee_id = :id`,
    employeeBinds(payload, id), {}, true
  );
}

async function remove(id) { return db.execute('DELETE FROM employees WHERE employee_id = :id', { id }, {}, true); }

async function removeWithPayroll(id) {
  return db.withConnection(async (conn) => {
    await conn.execute('DELETE FROM payroll WHERE employee_id = :id', { id });
    const result = await conn.execute('DELETE FROM employees WHERE employee_id = :id', { id });
    await conn.commit();
    return result;
  });
}

module.exports = { list, getById, create, update, remove, removeWithPayroll };
