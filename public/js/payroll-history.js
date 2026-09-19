const alertBox = document.getElementById('alertBox');
const tableBody = document.getElementById('historyTableBody');
const searchInput = document.getElementById('searchInput');
const monthFilter = document.getElementById('monthFilter');
const yearFilter = document.getElementById('yearFilter');
const bulkActions = document.getElementById('bulkActions');
const selectedCount = document.getElementById('selectedCount');
const approveSelectedBtn = document.getElementById('approveSelectedBtn');
const finalizeSelectedBtn = document.getElementById('finalizeSelectedBtn');
const holdSelectedBtn = document.getElementById('holdSelectedBtn');
const selectAllHeader = document.getElementById('selectAllHeader');
const selectAllRows = document.getElementById('selectAllRows');

monthFilter.innerHTML = '<option value="">All Months</option>' +
  MONTH_NAMES.slice(1).map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');

(async () => {
  if (!await requireLogin()) return;
  await loadHistory();
})();

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 300);
});
monthFilter.addEventListener('change', loadHistory);
yearFilter.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadHistory, 300);
});
selectAllHeader.addEventListener('change', () => setAllSelected(selectAllHeader.checked));
selectAllRows.addEventListener('change', () => setAllSelected(selectAllRows.checked));
approveSelectedBtn.addEventListener('click', () => updateSelectedRows('APPROVE'));
finalizeSelectedBtn.addEventListener('click', () => updateSelectedRows('FINALIZE'));
holdSelectedBtn.addEventListener('click', () => updateSelectedRows('HOLD'));

async function loadHistory() {
  clearAlert(alertBox);
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
  if (monthFilter.value) params.set('month', monthFilter.value);
  if (yearFilter.value) params.set('year', yearFilter.value);

  try {
    const data = await apiFetch('/api/payroll?' + params.toString());
    renderTable(data.records);
  } catch (err) {
    showAlert(alertBox, err.message || 'Failed to load payroll history.');
    tableBody.innerHTML = '<tr><td colspan="11" class="empty-state">Could not load payroll history.</td></tr>';
  }
}

function renderTable(records) {
  if (!records.length) {
    tableBody.innerHTML = '<tr><td colspan="11" class="empty-state">No payroll records found.</td></tr>';
    updateSelectionControls();
    return;
  }
  const canDelete = hasPermission('PAYROLL_DELETE');
  const canApprove = hasPermission('PAYROLL_APPROVE');
  const canFinalize = hasPermission('PAYROLL_FINALIZE');
  bulkActions.style.display = (canApprove || canFinalize) ? 'flex' : 'none';
  approveSelectedBtn.style.display = canApprove ? '' : 'none';
  finalizeSelectedBtn.style.display = canFinalize ? '' : 'none';
  holdSelectedBtn.style.display = canFinalize ? '' : 'none';
  tableBody.innerHTML = records.map((r) => `
    <tr>
      <td><input type="checkbox" data-payroll-select="${r.PAYROLL_ID}" ${r.APPROVAL_STATUS === 'FINALIZED' ? 'disabled' : ''} aria-label="Select payroll for ${escapeHtml(r.FULL_NAME)}"></td>
      <td><strong>${escapeHtml(r.EMPLOYEE_CODE)}</strong></td>
      <td>${escapeHtml(r.FULL_NAME)}</td>
      <td>${escapeHtml(r.DEPARTMENT || '-')}</td>
      <td>${MONTH_NAMES[r.PAY_MONTH]} ${r.PAY_YEAR}</td>
      <td>${fmtMoney(r.TOTAL_EARNINGS)}</td>
      <td>${fmtMoney(r.TOTAL_DEDUCTIONS)}</td>
      <td><strong>${fmtMoney(r.NET_SALARY)}</strong></td>
      <td>${payrollStatusBadge(r.APPROVAL_STATUS || r.RUN_STATUS)}</td>
      <td>${r.RUN_STATUS === 'FINALIZED' && r.APPROVAL_STATUS === 'FINALIZED' ? emailStatusBadge(r.EMAIL_DELIVERY_STATUS || r.EMAIL_STATUS) : '<span class="badge badge-inactive">Blocked</span>'}</td>
      <td>
        ${canDelete && r.RUN_STATUS === 'VALIDATED' ? `<button class="btn btn-danger btn-sm" onclick="deletePayrollRecord(${r.PAYROLL_ID}, decodeURIComponent('${encodeURIComponent(String(r.EMPLOYEE_CODE || '')).replace(/'/g, '%27')}'), decodeURIComponent('${encodeURIComponent(`${MONTH_NAMES[r.PAY_MONTH]} ${r.PAY_YEAR}`).replace(/'/g, '%27')}'))">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
  tableBody.querySelectorAll('[data-payroll-select]').forEach((input) => input.addEventListener('change', updateSelectionControls));
  updateSelectionControls();
}

function payrollStatusBadge(status) {
  const cls = status === 'FINALIZED' ? 'badge-active' : (status === 'HOLD' ? 'badge-inactive' : 'badge-info');
  return `<span class="badge ${cls}">${escapeHtml(status || 'VALIDATED')}</span>`;
}

function selectedPayrollIds() {
  return [...tableBody.querySelectorAll('[data-payroll-select]:checked:not(:disabled)')].map((input) => Number(input.dataset.payrollSelect));
}

function setAllSelected(checked) {
  tableBody.querySelectorAll('[data-payroll-select]:not(:disabled)').forEach((input) => { input.checked = checked; });
  selectAllHeader.checked = checked;
  selectAllRows.checked = checked;
  updateSelectionControls();
}

function updateSelectionControls() {
  const count = selectedPayrollIds().length;
  selectedCount.textContent = `${count} selected`;
  approveSelectedBtn.disabled = count === 0;
  finalizeSelectedBtn.disabled = count === 0;
  holdSelectedBtn.disabled = count === 0;
  const inputs = [...tableBody.querySelectorAll('[data-payroll-select]:not(:disabled)')];
  const allSelected = inputs.length > 0 && inputs.every((input) => input.checked);
  selectAllHeader.checked = allSelected;
  selectAllRows.checked = allSelected;
}

async function updateSelectedRows(action) {
  const ids = selectedPayrollIds();
  if (!ids.length) return;
  const labels = { APPROVE: 'approve', FINALIZE: 'finalize', HOLD: 'put on hold' };
  if (!confirm(`Are you sure you want to ${labels[action]} ${ids.length} selected payroll record${ids.length === 1 ? '' : 's'}?`)) return;
  try {
    const endpoint = `/api/payroll/rows/${action.toLowerCase()}`;
    await apiFetch(endpoint, { method: 'POST', body: { payrollIds: ids, action } });
    clearAlert(alertBox);
    await loadHistory();
  } catch (err) {
    showAlert(alertBox, err.message || `Failed to ${labels[action]} selected payroll records.`);
  }
}

function emailStatusBadge(status) {
  if (!status) return '<span style="color:var(--text-muted);font-size:12.5px;">Not sent</span>';
  const cls = status === 'SENT' ? 'badge-active' : (status === 'FAILED' ? 'badge-inactive' : 'badge-info');
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

window.deletePayrollRecord = async function (payrollId, code, period) {
  if (!confirm(`Delete the ${period} payroll record for ${code}? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/payroll/${payrollId}`, { method: 'DELETE' });
    await loadHistory();
  } catch (err) {
    showAlert(alertBox, err.message || 'Failed to delete payroll record.');
  }
};
