const settingsAlert = document.getElementById('alertBox');
(async () => {
  if (!await requireLogin()) return;
  try {
    const data = await apiFetch('/api/system/configuration');
    document.getElementById('environmentValue').textContent = data.configuration.environment;
    document.getElementById('sessionTtlValue').textContent = `${data.configuration.sessionTtlMinutes} minutes`;
    document.getElementById('absoluteTtlValue').textContent = `${data.configuration.sessionAbsoluteTtlMinutes} minutes`;
    document.getElementById('emailValue').textContent = data.configuration.emailNotificationsEnabled ? 'Enabled' : 'Disabled';
    document.getElementById('smtpValue').innerHTML = data.configuration.emailNotificationsEnabled
      ? '<span class="badge badge-active">Enabled</span>'
      : '<span class="badge badge-info">Disabled for local use</span>';
  } catch (err) { showAlert(settingsAlert, err.message || 'Unable to load settings.'); }
})();
