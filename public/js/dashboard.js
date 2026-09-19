(async () => {
  if (!await requireLogin()) return;

  const alertBox = document.getElementById('alertBox');
  try {
    const data = await apiFetch('/api/dashboard/summary');

    document.getElementById('statTotalEmp').textContent = data.totalEmployees;
    document.getElementById('statActiveEmp').textContent = `${data.activeEmployees} active`;
    document.getElementById('statPayrollCount').textContent = data.totalPayrollRecords;

    if (data.latestPeriod) {
      document.getElementById('statLatestTotal').textContent = fmtMoney(data.latestPeriod.TOTAL);
      document.getElementById('statLatestPeriod').textContent =
        `${MONTH_NAMES[data.latestPeriod.PAY_MONTH]} ${data.latestPeriod.PAY_YEAR} · ${data.latestPeriod.CNT} employees`;
    } else {
      document.getElementById('statLatestTotal').textContent = fmtMoney(0);
      document.getElementById('statLatestPeriod').textContent = 'No payroll uploaded yet';
    }

    const depts = data.departmentBreakdown || [];
    document.getElementById('statDeptCount').textContent = depts.length;

    const tbody = document.getElementById('deptTableBody');
    if (!depts.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty-state">No employees yet.</td></tr>';
    } else {
      tbody.innerHTML = depts.map((d) => `
        <tr><td>${escapeHtml(d.DEPARTMENT || 'Unassigned')}</td><td>${d.CNT}</td></tr>
      `).join('');
    }
  } catch (err) {
    showAlert(alertBox, err.message || 'Failed to load dashboard data.');
  }
})();
