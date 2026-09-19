let allEmployees = [];

const alertBox = document.getElementById('alertBox');
const tableBody = document.getElementById('employeeTableBody');
const searchInput = document.getElementById('searchInput');
const departmentFilter = document.getElementById('departmentFilter');
const statusFilter = document.getElementById('statusFilter');

const modal = document.getElementById('employeeModal');
const modalTitle = document.getElementById('modalTitle');
const modalAlert = document.getElementById('modalAlert');
const employeeForm = document.getElementById('employeeForm');

(async () => {
  if (!await requireLogin()) return;
  await loadEmployees();
})();

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadEmployees, 300);
});
departmentFilter.addEventListener('change', loadEmployees);
statusFilter.addEventListener('change', loadEmployees);

async function loadEmployees() {
  clearAlert(alertBox);
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (departmentFilter.value) params.set('department', departmentFilter.value);
  if (statusFilter.value) params.set('status', statusFilter.value);

  try {
    const data = await apiFetch('/api/employees?' + params.toString());
    allEmployees = data.employees;
    renderTable(allEmployees);
    populateDepartmentFilter(allEmployees);
  } catch (err) {
    showAlert(alertBox, err.message || 'Failed to load employees.');
    tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">Could not load employees.</td></tr>';
  }
}

function populateDepartmentFilter(employees) {
  const current = departmentFilter.value;
  const depts = [...new Set(employees.map((e) => e.DEPARTMENT).filter(Boolean))].sort();
  departmentFilter.innerHTML = '<option value="">All Departments</option>' +
    depts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
  departmentFilter.value = current;
}

function renderTable(employees) {
  if (!employees.length) {
    tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No employees found.</td></tr>';
    return;
  }
  const canUpdate = hasPermission('EMPLOYEE_UPDATE');
  const canDelete = hasPermission('EMPLOYEE_DELETE');
  tableBody.innerHTML = employees.map((e) => `
    <tr>
      <td><strong>${escapeHtml(e.EMPLOYEE_CODE)}</strong></td>
      <td>${escapeHtml(e.FULL_NAME)}</td>
      <td>${escapeHtml(e.DEPARTMENT || '-')}</td>
      <td>${escapeHtml(e.DESIGNATION || '-')}</td>
      <td>${escapeHtml(e.EMAIL || '-')}</td>
      <td><span class="badge ${e.STATUS === 'ACTIVE' ? 'badge-active' : 'badge-inactive'}">${escapeHtml(e.STATUS)}</span></td>
      <td class="actions-cell">
        ${canUpdate ? `<button class="btn btn-outline btn-sm" onclick="openEditModal(${e.EMPLOYEE_ID})">Edit</button>` : ''}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteEmployee(${e.EMPLOYEE_ID}, decodeURIComponent('${encodeURIComponent(String(e.EMPLOYEE_CODE || '')).replace(/'/g, '%27')}'))">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
}

document.getElementById('addEmployeeBtn').addEventListener('click', () => openAddModal());
document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function openAddModal() {
  modalTitle.textContent = 'Add Employee';
  employeeForm.reset();
  document.getElementById('employeeId').value = '';
  document.getElementById('status').value = 'ACTIVE';
  clearAlert(modalAlert);
  modal.classList.add('open');
}

window.openEditModal = function (id) {
  const emp = allEmployees.find((e) => e.EMPLOYEE_ID === id);
  if (!emp) return;
  modalTitle.textContent = 'Edit Employee';
  clearAlert(modalAlert);
  document.getElementById('employeeId').value = emp.EMPLOYEE_ID;
  document.getElementById('employeeCode').value = emp.EMPLOYEE_CODE || '';
  document.getElementById('fullName').value = emp.FULL_NAME || '';
  document.getElementById('department').value = emp.DEPARTMENT || '';
  document.getElementById('designation').value = emp.DESIGNATION || '';
  document.getElementById('email').value = emp.EMAIL || '';
  document.getElementById('phone').value = emp.PHONE || '';
  document.getElementById('dateOfJoining').value = emp.DATE_OF_JOINING ? emp.DATE_OF_JOINING.substring(0, 10) : '';
  document.getElementById('status').value = emp.STATUS || 'ACTIVE';
  document.getElementById('bankAccount').value = emp.BANK_ACCOUNT || '';
  document.getElementById('bankName').value = emp.BANK_NAME || '';
  document.getElementById('ifscCode').value = emp.IFSC_CODE || '';
  document.getElementById('panNo').value = emp.PAN_NO || '';
  modal.classList.add('open');
};

function closeModal() {
  modal.classList.remove('open');
}

employeeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAlert(modalAlert);
  const saveBtn = document.getElementById('saveEmployeeBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  const id = document.getElementById('employeeId').value;
  const payload = {
    employeeCode: document.getElementById('employeeCode').value.trim(),
    fullName: document.getElementById('fullName').value.trim(),
    department: document.getElementById('department').value.trim(),
    designation: document.getElementById('designation').value.trim(),
    email: document.getElementById('email').value.trim(),
    phone: document.getElementById('phone').value.trim(),
    dateOfJoining: document.getElementById('dateOfJoining').value || null,
    status: document.getElementById('status').value,
    bankAccount: document.getElementById('bankAccount').value.trim(),
    bankName: document.getElementById('bankName').value.trim(),
    ifscCode: document.getElementById('ifscCode').value.trim(),
    panNo: document.getElementById('panNo').value.trim()
  };

  try {
    if (id) {
      await apiFetch(`/api/employees/${id}`, { method: 'PUT', body: payload });
    } else {
      await apiFetch('/api/employees', { method: 'POST', body: payload });
    }
    closeModal();
    await loadEmployees();
  } catch (err) {
    showAlert(modalAlert, err.message || 'Failed to save employee.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Employee';
  }
});

window.deleteEmployee = async function (id, code) {
  if (!confirm(`Delete employee ${code}? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/employees/${id}`, { method: 'DELETE' });
    await loadEmployees();
  } catch (err) {
    if (err.message && err.message.includes('has payroll records')) {
      if (confirm(`${code} has existing payroll records. Delete ${code} AND all of their payroll history? This cannot be undone.`)) {
        try {
          await apiFetch(`/api/employees/${id}?cascade=true`, { method: 'DELETE' });
          await loadEmployees();
        } catch (err2) {
          showAlert(alertBox, err2.message || 'Failed to delete employee and payroll records.');
        }
      }
      return;
    }
    showAlert(alertBox, err.message || 'Failed to delete employee.');
  }
};
