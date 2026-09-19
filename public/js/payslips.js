const payslipAlert = document.getElementById('alertBox');
const payslipBody = document.getElementById('payslipTableBody');
const payslipSearch = document.getElementById('payslipSearch');
const payslipMonth = document.getElementById('payslipMonth');
const payslipYear = document.getElementById('payslipYear');
const selectAll = document.getElementById('selectAllPayslips');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
const emailSelectedBtn = document.getElementById('emailSelectedBtn');
let canEmail = false;
let payslips = [];
let searchTimer;

payslipMonth.innerHTML = '<option value="">All months</option>' + MONTH_NAMES.slice(1).map((name, index) => `<option value="${index + 1}">${name}</option>`).join('');

(async () => {
  if (!await requireLogin()) return;
  canEmail = hasPermission('PAYSLIP_EMAIL');
  emailSelectedBtn.style.display = canEmail ? '' : 'none';
  await loadPayslips();
})();

for (const input of [payslipSearch, payslipMonth, payslipYear]) {
  input.addEventListener(input === payslipSearch ? 'input' : 'change', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPayslips, 250);
  });
}

selectAll.addEventListener('change', () => {
  payslipBody.querySelectorAll('input[data-payslip-id]').forEach((input) => { input.checked = selectAll.checked; });
  updateSelection();
});
downloadSelectedBtn.addEventListener('click', downloadSelected);
emailSelectedBtn.addEventListener('click', emailSelected);
document.getElementById('previousPayslipBtn').addEventListener('click', () => {
  const date = new Date(); date.setMonth(date.getMonth() - 1);
  payslipMonth.value = String(date.getMonth() + 1); payslipYear.value = String(date.getFullYear()); loadPayslips();
});

async function loadPayslips() {
  clearAlert(payslipAlert);
  const params = new URLSearchParams();
  if (payslipSearch.value.trim()) params.set('search', payslipSearch.value.trim());
  if (payslipMonth.value) params.set('month', payslipMonth.value);
  if (payslipYear.value) params.set('year', payslipYear.value);
  try {
    const data = await apiFetch(`/api/payslips?${params}`);
    payslips = data.records || [];
    renderPayslips();
  } catch (err) {
    showAlert(payslipAlert, err.status === 403 ? 'You do not have permission to view payslips, or your account is not linked to an employee.' : (err.message || 'Failed to load payslips.'));
    payslipBody.innerHTML = '<tr><td colspan="8" class="empty-state">Payslips are unavailable right now.</td></tr>';
  }
}

function renderPayslips() {
  selectAll.checked = false;
  document.getElementById('payslipCount').textContent = `${payslips.length} available`;
  if (!payslips.length) {
    payslipBody.innerHTML = '<tr><td colspan="8" class="empty-state">No generated payslips match your filters.</td></tr>';
    updateSelection();
    return;
  }
  payslipBody.innerHTML = payslips.map((record) => `<tr><td><input type="checkbox" data-payslip-id="${record.PAYROLL_ID}" aria-label="Select payslip for ${escapeHtml(record.FULL_NAME)}"></td><td><strong>${escapeHtml(record.EMPLOYEE_CODE)}</strong><br><span class="muted">${escapeHtml(record.FULL_NAME)}</span></td><td>${escapeHtml(record.DEPARTMENT || '-')}</td><td>${MONTH_NAMES[record.PAY_MONTH]} ${record.PAY_YEAR}</td><td><strong>${fmtMoney(record.NET_SALARY)}</strong></td><td data-email-status="${record.PAYROLL_ID}">${emailBadge(record.EMAIL_DELIVERY_STATUS)}</td><td>${fmtDate(record.GENERATED_AT)}</td><td><a class="btn btn-outline btn-sm" href="/api/payroll/${record.PAYROLL_ID}/payslip" target="_blank" rel="noopener">Download</a>${canEmail ? ` <button class="btn btn-outline btn-sm" type="button" data-email-payslip="${record.PAYROLL_ID}" ${emailActionDisabled(record.EMAIL_DELIVERY_STATUS) ? 'disabled' : ''}>${emailActionLabel(record.EMAIL_DELIVERY_STATUS)}</button>` : ''}</td></tr>`).join('');
  payslipBody.querySelectorAll('input[data-payslip-id]').forEach((input) => input.addEventListener('change', updateSelection));
  payslipBody.querySelectorAll('[data-email-payslip]').forEach((button) => button.addEventListener('click', () => emailSingle(button.dataset.emailPayslip, button)));
  updateSelection();
}

function emailBadge(status) {
  if (status === 'SENT') return '<span class="badge badge-active">Sent</span>';
  if (status === 'FAILED') return '<span class="badge badge-inactive">Failed</span>';
  if (status === 'PENDING' || status === 'PROCESSING') return `<span class="badge badge-info">${escapeHtml(status)}</span>`;
  return '<span class="muted">Not queued</span>';
}

function updateSelection() {
  const selected = payslipBody.querySelectorAll('input[data-payslip-id]:checked').length;
  downloadSelectedBtn.disabled = selected === 0;
  emailSelectedBtn.disabled = !canEmail || selected === 0;
  downloadSelectedBtn.textContent = selected ? `Download selected (${selected})` : 'Download selected';
  emailSelectedBtn.textContent = selected ? `Email selected (${selected})` : 'Email selected';
}

function emailActionLabel(status) {
  if (status === 'FAILED') return 'Retry email';
  if (status === 'SENT') return 'Sent';
  if (status === 'PENDING' || status === 'PROCESSING') return 'Queued';
  return 'Queue email';
}

function emailActionDisabled(status) {
  return ['PENDING', 'PROCESSING', 'SENT'].includes(status);
}

function selectedPayslipIds() {
  return [...payslipBody.querySelectorAll('input[data-payslip-id]:checked')].map((input) => Number(input.dataset.payslipId));
}

async function emailSelected() {
  const ids = selectedPayslipIds();
  if (!ids.length) return;
  if (!confirm(`Queue email delivery for ${ids.length} payslip${ids.length === 1 ? '' : 's'}?`)) return;
  emailSelectedBtn.disabled = true;
  try {
    const results = [];
    for (let index = 0; index < ids.length; index += 5) {
      const batch = await Promise.all(ids.slice(index, index + 5).map(async (payrollId) => {
        try {
          const response = await apiFetch(`/api/payroll/${encodeURIComponent(payrollId)}/send-slip`, { method: 'POST' });
          return response.result;
        } catch (err) {
          return { payrollId, status: 'FAILED', message: err.message || 'Email could not be queued.' };
        }
      }));
      results.push(...batch);
    }
    const queued = results.filter((result) => result.status === 'PENDING').length;
    const sent = results.filter((result) => result.status === 'SENT').length;
    const failed = results.filter((result) => result.status === 'FAILED').length;
    showAlert(payslipAlert, `${queued} queued, ${sent} already sent, ${failed} failed.`, failed ? 'warning' : 'success');
    await loadPayslips();
  } catch (err) {
    showAlert(payslipAlert, err.message || 'Failed to queue payslip emails.');
    updateSelection();
  }
}

async function emailSingle(payrollId, button) {
  button.disabled = true;
  button.textContent = 'Queueing...';
  try {
    const result = await apiFetch(`/api/payroll/${encodeURIComponent(payrollId)}/send-slip`, { method: 'POST' });
    const statusCell = payslipBody.querySelector(`[data-email-status="${CSS.escape(String(payrollId))}"]`);
    if (statusCell) statusCell.innerHTML = emailBadge(result.result.status);
    button.textContent = emailActionLabel(result.result.status);
    button.disabled = emailActionDisabled(result.result.status);
    showAlert(payslipAlert, result.result.message || 'Payslip email queued.', 'success');
  } catch (err) {
    button.textContent = 'Retry email';
    button.disabled = false;
    showAlert(payslipAlert, err.message || 'Failed to queue payslip email.');
  }
}

function downloadSelected() {
  const ids = [...payslipBody.querySelectorAll('input[data-payslip-id]:checked')].map((input) => input.dataset.payslipId);
  if (!ids.length) return;
  ids.forEach((id, index) => {
    window.setTimeout(() => {
      const link = document.createElement('a');
      link.href = `/api/payroll/${encodeURIComponent(id)}/payslip`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
    }, index * 120);
  });
  showAlert(payslipAlert, `${ids.length} payslip download${ids.length === 1 ? '' : 's'} started. Your browser may ask you to allow multiple downloads.`, 'success');
}
