const changeForm = document.getElementById('changePasswordForm');
const changeAlert = document.getElementById('alertBox');
const changeButton = document.getElementById('changePasswordBtn');

(async () => { await requireLogin(); })();

changeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAlert(changeAlert);
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  if (newPassword !== confirmation) return showAlert(changeAlert, 'New passwords do not match.');
  changeButton.disabled = true;
  try {
    const data = await apiFetch('/api/password/change', { method: 'POST', body: { currentPassword, newPassword } });
    window.location.href = landingPageFor(data.user);
  } catch (err) {
    showAlert(changeAlert, err.message || 'Password could not be changed.');
  } finally {
    changeButton.disabled = false;
  }
});
