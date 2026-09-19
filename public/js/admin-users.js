const usersAlert = document.getElementById('alertBox');
const usersBody = document.getElementById('usersTableBody');
const userModal = document.getElementById('userModal');
const userForm = document.getElementById('userForm');
let availableRoles = [];
let users = [];

(async () => {
  if (!await requireLogin()) return;
  await Promise.all([loadUsers(), loadRoles()]);
  document.getElementById('addUserBtn')?.addEventListener('click', () => openUserModal());
  document.getElementById('closeUserModal')?.addEventListener('click', closeUserModal);
  document.getElementById('cancelUserModal')?.addEventListener('click', closeUserModal);
  userForm?.addEventListener('submit', saveUser);
})();

async function loadRoles() {
  try {
    const data = await apiFetch('/api/roles');
    availableRoles = data.roles || [];
  } catch (err) { availableRoles = []; }
}

async function loadUsers() {
  try {
    const data = await apiFetch('/api/users');
    users = data.users || [];
    if (!users.length) { usersBody.innerHTML = '<tr><td colspan="5" class="empty-state">No users found.</td></tr>'; return; }
    const canEdit = hasPermission('USER_UPDATE');
    const canDeactivate = hasPermission('USER_DEACTIVATE');
    usersBody.innerHTML = users.map((user) => `<tr><td><strong>${escapeHtml(user.USERNAME)}</strong></td><td>${escapeHtml(user.FULL_NAME || '-')}</td><td>${user.IS_ACTIVE === 1 ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td><td>${fmtDate(user.LAST_LOGIN_AT)}</td><td class="actions-cell">${canEdit ? `<button class="btn btn-outline btn-sm" type="button" data-edit-user="${user.USER_ID}">Edit</button>` : ''}${canDeactivate && user.IS_ACTIVE === 1 ? `<button class="btn btn-danger btn-sm" type="button" data-deactivate-user="${user.USER_ID}">Deactivate</button>` : ''}</td></tr>`).join('');
    usersBody.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => openUserModal(Number(button.dataset.editUser))));
    usersBody.querySelectorAll('[data-deactivate-user]').forEach((button) => button.addEventListener('click', () => deactivateUser(Number(button.dataset.deactivateUser))));
  } catch (err) { showAlert(usersAlert, err.message || 'Unable to load users.'); usersBody.innerHTML = '<tr><td colspan="5" class="empty-state">Could not load users.</td></tr>'; }
}

function renderRoleChoices(selected = []) {
  const selectedSet = new Set(selected);
  document.getElementById('roleChoices').innerHTML = availableRoles.map((role) => `<label class="role-choice"><input type="checkbox" name="role" value="${escapeHtml(role.code)}" ${selectedSet.has(role.code) ? 'checked' : ''}><span><strong>${escapeHtml(role.code)}</strong><small>${escapeHtml(role.description || role.name || '')}</small></span></label>`).join('');
}

function openUserModal(userId = null) {
  const user = users.find((item) => Number(item.USER_ID) === userId);
  document.getElementById('userModalTitle').textContent = user ? `Edit ${user.USERNAME}` : 'Add user';
  document.getElementById('userId').value = user ? user.USER_ID : '';
  document.getElementById('userUsername').value = user?.USERNAME || '';
  document.getElementById('userUsername').disabled = Boolean(user);
  document.getElementById('userFullName').value = user?.FULL_NAME || '';
  document.getElementById('userEmail').value = user?.EMAIL || '';
  document.getElementById('userPassword').value = '';
  document.getElementById('userPassword').required = !user;
  document.getElementById('userPasswordGroup').hidden = Boolean(user);
  document.getElementById('initialRoleGroup').hidden = Boolean(user);
  document.getElementById('saveUserBtn').textContent = user ? 'Save changes' : 'Create user';
  document.getElementById('userModalAlert').innerHTML = '';
  if (!user) renderRoleChoices();
  userModal.classList.add('open');
}

function closeUserModal() { userModal.classList.remove('open'); }

async function saveUser(event) {
  event.preventDefault();
  const userId = Number(document.getElementById('userId').value) || null;
  const roles = userId ? [] : [...document.querySelectorAll('input[name="role"]:checked')].map((input) => input.value);
  const payload = { fullName: document.getElementById('userFullName').value.trim(), email: document.getElementById('userEmail').value.trim() || null };
  if (!userId) Object.assign(payload, { username: document.getElementById('userUsername').value.trim(), password: document.getElementById('userPassword').value, roles });
  const alert = document.getElementById('userModalAlert');
  if (!userId && !roles.length) { showAlert(alert, 'Select at least one initial role.'); return; }
  try {
    if (userId) {
      await apiFetch(`/api/users/${userId}`, { method: 'PUT', body: payload });
    } else await apiFetch('/api/users', { method: 'POST', body: payload });
    closeUserModal(); showAlert(usersAlert, userId ? 'User updated successfully.' : 'User created successfully.', 'success'); await loadUsers();
  } catch (err) { showAlert(alert, err.message || 'Could not save user.'); }
}

async function deactivateUser(userId) {
  const user = users.find((item) => Number(item.USER_ID) === userId);
  if (!user || !confirm(`Deactivate ${user.USERNAME}? They will no longer be able to sign in.`)) return;
  try { await apiFetch(`/api/users/${userId}/deactivate`, { method: 'POST' }); showAlert(usersAlert, 'User deactivated.', 'success'); await loadUsers(); }
  catch (err) { showAlert(usersAlert, err.message || 'Could not deactivate user.'); }
}
