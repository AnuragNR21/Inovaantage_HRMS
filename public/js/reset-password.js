const resetForm = document.getElementById('resetPasswordForm');
const resetAlert = document.getElementById('alertBox');
const resetButton = document.getElementById('resetPasswordBtn');
const resetToken = new URLSearchParams(window.location.hash.slice(1)).get('token');
window.history.replaceState({}, '', '/reset-password.html');

if (!resetToken) {
  showAlert(resetAlert, 'Reset link is invalid or expired.');
  resetButton.disabled = true;
}

resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const newPassword = document.getElementById('newPassword').value;
  const confirmation = document.getElementById('confirmPassword').value;
  if (newPassword !== confirmation) return showAlert(resetAlert, 'New passwords do not match.');
  resetButton.disabled = true;
  try {
    await apiFetch('/api/password/reset', { method: 'POST', body: { token: resetToken, newPassword } });
    showAlert(resetAlert, 'Password reset. You can now sign in.', 'success');
    resetForm.hidden = true;
  } catch (err) {
    showAlert(resetAlert, err.message || 'Password could not be reset.');
    resetButton.disabled = false;
  }
});
