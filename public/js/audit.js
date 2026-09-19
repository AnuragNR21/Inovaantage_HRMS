const auditAlert = document.getElementById('alertBox');
const auditBody = document.getElementById('auditTableBody');

(async () => {
  if (!await requireLogin()) return;
  await loadAudit();
})();

async function loadAudit() {
  try {
    const data = await apiFetch('/api/audit?limit=200');
    if (!data.records || !data.records.length) {
      auditBody.innerHTML = '<tr><td colspan="6" class="empty-state">No audit events recorded.</td></tr>';
      return;
    }
    auditBody.innerHTML = data.records.map((event) => `
      <tr><td>${fmtDate(event.createdAt)}</td><td>${escapeHtml(event.action)}</td>
      <td>${escapeHtml(event.resourceType)}${event.resourceId ? ` #${escapeHtml(event.resourceId)}` : ''}</td>
      <td>${escapeHtml(event.actorUserId || 'System')}</td>
      <td><span class="badge ${event.result === 'SUCCESS' ? 'badge-active' : 'badge-inactive'}">${escapeHtml(event.result)}</span></td>
      <td><code>${escapeHtml(event.metadata ? JSON.stringify(event.metadata) : '-')}</code></td></tr>
    `).join('');
  } catch (err) {
    showAlert(auditAlert, err.message || 'Unable to load audit events.');
    auditBody.innerHTML = '<tr><td colspan="6" class="empty-state">Could not load audit events.</td></tr>';
  }
}
