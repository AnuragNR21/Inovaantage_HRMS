const rolesAlert = document.getElementById('rolesAlert');
const rolesBody = document.getElementById('rolesTableBody');
const roleUsersBody = document.getElementById('roleUsersTableBody');
const roleModal = document.getElementById('roleModal');
const roleForm = document.getElementById('roleForm');
let availableRoles = [];
let roleUsers = [];

(async () => {
  if (!await requireLogin()) return;
  await loadRoles();
  if (hasPermission('USER_VIEW')) await loadRoleUsers();
  document.getElementById('closeRoleModal')?.addEventListener('click', closeRoleModal);
  document.getElementById('cancelRoleModal')?.addEventListener('click', closeRoleModal);
  roleForm?.addEventListener('submit', saveRoles);
})();

async function loadRoles() {
  try {
    const data = await apiFetch('/api/roles');
    availableRoles = data.roles || [];
    rolesBody.innerHTML = availableRoles.map((role) => `<tr><td><strong>${escapeHtml(role.code)}</strong><br><span class="muted">${escapeHtml(role.name || '')}</span></td><td>${escapeHtml(role.description || '-')}</td><td><div class="permission-list">${(role.permissions || []).map((permission) => `<code>${escapeHtml(permission)}</code>`).join('')}</div></td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">No active roles found.</td></tr>';
  } catch (err) {
    rolesBody.innerHTML = '<tr><td colspan="3" class="empty-state">Role definitions could not be loaded.</td></tr>';
    showAlert(rolesAlert, err.message || 'Unable to load roles.');
  }
}

async function loadRoleUsers() {
  try {
    const data = await apiFetch('/api/users');
    roleUsers = data.users || [];
    if (!roleUsers.length) { roleUsersBody.innerHTML = '<tr><td colspan="5" class="empty-state">No users found.</td></tr>'; return; }
    const canAssign = hasPermission('USER_UPDATE') && hasPermission('ROLE_ASSIGN');
    roleUsersBody.innerHTML = roleUsers.map((user) => `<tr><td><strong>${escapeHtml(user.USERNAME)}</strong></td><td>${escapeHtml(user.FULL_NAME || '-')}</td><td>${escapeHtml((user.ROLES || []).join(', ') || user.ROLE || '-')}</td><td>${user.IS_ACTIVE === 1 ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>'}</td><td>${canAssign ? `<button class="btn btn-outline btn-sm" type="button" data-manage-roles="${user.USER_ID}">Manage roles</button>` : '<span class="muted">View only</span>'}</td></tr>`).join('');
    roleUsersBody.querySelectorAll('[data-manage-roles]').forEach((button) => button.addEventListener('click', () => openRoleModal(Number(button.dataset.manageRoles))));
  } catch (err) {
    roleUsersBody.innerHTML = '<tr><td colspan="5" class="empty-state">Role assignments could not be loaded.</td></tr>';
    showAlert(rolesAlert, err.message || 'Unable to load user role assignments.');
  }
}

function openRoleModal(userId) {
  const user = roleUsers.find((item) => Number(item.USER_ID) === userId);
  if (!user) return;
  const selected = new Set(user.ROLES || []);
  document.getElementById('roleUserId').value = user.USER_ID;
  document.getElementById('roleModalTitle').textContent = `Manage roles for ${user.USERNAME}`;
  document.getElementById('roleModalAlert').innerHTML = '';
  document.getElementById('assignmentRoleChoices').innerHTML = availableRoles.map((role) => `<label class="role-choice"><input type="checkbox" name="assignedRole" value="${escapeHtml(role.code)}" ${selected.has(role.code) ? 'checked' : ''}><span><strong>${escapeHtml(role.code)}</strong><small>${escapeHtml(role.description || role.name || '')}</small></span></label>`).join('');
  roleModal.classList.add('open');
}

function closeRoleModal() { roleModal.classList.remove('open'); }

async function saveRoles(event) {
  event.preventDefault();
  const userId = Number(document.getElementById('roleUserId').value);
  const roles = [...document.querySelectorAll('input[name="assignedRole"]:checked')].map((input) => input.value);
  const alert = document.getElementById('roleModalAlert');
  if (!roles.length) { showAlert(alert, 'Select at least one role.'); return; }
  try {
    await apiFetch(`/api/users/${userId}/roles`, { method: 'PUT', body: { roles } });
    closeRoleModal();
    showAlert(rolesAlert, 'Role assignment updated successfully.', 'success');
    await loadRoleUsers();
  } catch (err) { showAlert(alert, err.message || 'Could not update role assignment.'); }
}
