document.getElementById('year').textContent = new Date().getFullYear();

// If already logged in, skip straight to dashboard.
(async () => {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      window.location.href = landingPageFor(data.user);
    }
  } catch (e) { /* not logged in, stay on page */ }
})();

const form = document.getElementById('loginForm');
const alertBox = document.getElementById('alertBox');
const loginBtn = document.getElementById('loginBtn');
const forgotPasswordForm = document.getElementById('forgotPasswordForm');

document.getElementById('forgotPasswordBtn').addEventListener('click', () => {
  form.hidden = true;
  forgotPasswordForm.hidden = false;
  clearAlert(alertBox);
});
document.getElementById('backToLoginBtn').addEventListener('click', () => {
  forgotPasswordForm.hidden = true;
  form.hidden = false;
  clearAlert(alertBox);
});

forgotPasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await apiFetch('/api/password/forgot', {
      method: 'POST',
      body: { username: document.getElementById('resetUsername').value.trim() }
    });
    showAlert(alertBox, data.message, 'success');
  } catch (err) {
    showAlert(alertBox, err.message || 'Could not request a reset.');
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const data = await apiFetch('/api/login', { method: 'POST', body: { username, password } });
    window.location.href = data.user.mustChangePassword ? '/change-password.html' : landingPageFor(data.user);
  } catch (err) {
    showAlert(alertBox, err.message || 'Login failed.');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});
