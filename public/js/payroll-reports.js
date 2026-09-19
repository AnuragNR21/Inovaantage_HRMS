const reportAlert = document.getElementById('reportAlert');
const runReportBody = document.getElementById('runReportBody');
let reports = [];

(async () => { if (!await requireLogin()) return; await loadReports(); })();
document.getElementById('exportRunsBtn').addEventListener('click', exportReports);

async function loadReports() {
  clearAlert(reportAlert);
  try {
    const data = await apiFetch('/api/payroll/reports');
    reports = data.reports || [];
    renderSummary();
    renderReports();
  } catch (err) {
    showAlert(reportAlert, err.message || 'Could not load payroll reports.');
    runReportBody.innerHTML = '<tr><td colspan="10" class="empty-state">Payroll reports are unavailable.</td></tr>';
  }
}

function renderSummary() {
  const sum = (field) => reports.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  document.getElementById('runCount').textContent = reports.length;
  document.getElementById('employeeCount').textContent = sum('EMPLOYEE_COUNT');
  document.getElementById('totalNet').textContent = fmtMoney(sum('NET_SALARY'));
  document.getElementById('holdCount').textContent = reports.filter((row) => row.STATUS === 'FAILED').length;
}

function renderReports() {
  if (!reports.length) {
    runReportBody.innerHTML = '<tr><td colspan="10" class="empty-state">No payroll reports found.</td></tr>';
    return;
  }
  const canControl = false;
  runReportBody.innerHTML = reports.map((row) => `<tr><td><strong>${MONTH_NAMES[row.PAY_MONTH]} ${row.PAY_YEAR}</strong><br><span class="muted">Run #${row.RUN_ID}</span></td><td>${Number(row.EMPLOYEE_COUNT) || 0} employees</td><td>${fmtMoney(row.TOTAL_EARNINGS)}</td><td>${fmtMoney(row.TOTAL_DEDUCTIONS)}</td><td><strong>${fmtMoney(row.NET_SALARY)}</strong></td><td>${Number(row.GENERATED_PAYSLIPS) || 0} / ${Number(row.EMPLOYEE_COUNT) || 0}</td><td>${Number(row.EMAILS_SENT) || 0}</td><td>${fmtDate(row.UPDATED_AT)}</td><td>${statusControl(row, canControl)}</td><td><button class="btn btn-outline btn-sm" type="button" data-export-run="${row.RUN_ID}">Export details</button></td></tr>`).join('');
  runReportBody.querySelectorAll('[data-run-status]').forEach((select) => select.addEventListener('change', () => changeStatus(select)));
  runReportBody.querySelectorAll('[data-export-run]').forEach((button) => button.addEventListener('click', () => exportDetailedReport(button)));
}

function statusControl(row, canControl) {
  if (!canControl) {
    const cls = row.STATUS === 'FAILED' ? 'badge-inactive' : (row.STATUS === 'VALIDATED' ? 'badge-info' : 'badge-active');
    return `<span class="badge ${cls}">${escapeHtml(row.STATUS)}</span>`;
  }
  return `<span class="badge badge-info">${escapeHtml(row.STATUS)}</span>`;
}

async function changeStatus(select) {
  return;
}

function exportReports() {
  const rows = [['Period','Run ID','Status','Employees','Gross Earnings','Deductions','Net Payroll','Generated Payslips','Emails Sent'], ...reports.map((r) => [`${MONTH_NAMES[r.PAY_MONTH]} ${r.PAY_YEAR}`,r.RUN_ID,r.STATUS,r.EMPLOYEE_COUNT,r.TOTAL_EARNINGS,r.TOTAL_DEDUCTIONS,r.NET_SALARY,r.GENERATED_PAYSLIPS,r.EMAILS_SENT])];
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = 'payroll-run-reports.csv'; link.click(); URL.revokeObjectURL(link.href);
}

async function exportDetailedReport(button) {
  const runId = Number(button.dataset.exportRun);
  const report = reports.find((row) => Number(row.RUN_ID) === runId);
  if (!report) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing...';
  clearAlert(reportAlert);
  try {
    const response = await fetch(`/api/payroll/reports/${runId}/export`, { credentials: 'same-origin' });
    if (response.status === 401) { window.location.href = '/index.html'; return; }
    if (!response.ok) {
      let message = `Export failed (${response.status})`;
      try { message = (await response.json()).message || message; } catch (_) { /* response may not be JSON */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const month = String(MONTH_NAMES[report.PAY_MONTH] || report.PAY_MONTH).toLowerCase();
    downloadCsvBlob(blob, `payroll-details-${month}-${report.PAY_YEAR}.csv`);
  } catch (err) {
    showAlert(reportAlert, err.message || 'Could not export payroll details.');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function downloadCsvBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
