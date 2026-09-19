// Shared helpers used across all pages.

let currentUser = null;

async function apiFetch(path, options = {}) {
  const opts = Object.assign({ credentials: 'same-origin' }, options);
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON (e.g. PDF) handled by caller */ }

  if (res.status === 401 && !path.includes('/api/login')) {
    window.location.href = '/index.html';
    throw new Error('Not authenticated');
  }
  if (res.status === 403 && data && data.code === 'PASSWORD_CHANGE_REQUIRED') {
    window.location.href = '/change-password.html';
    throw new Error('Password change required');
  }
  if (!res.ok) {
    const message = (data && data.message) || `Request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.code = data && data.code;
    throw error;
  }
  return data;
}

async function requireLogin() {
  try {
    const data = await apiFetch('/api/me');
    if (data.user.mustChangePassword && window.location.pathname !== '/change-password.html') {
      window.location.href = '/change-password.html';
      return null;
    }
    currentUser = data.user;
    renderUserBox(data.user);
    renderApplicationNav(data.user);
    applyPermissionVisibility(data.user.permissions || []);
    if (!enforcePageAccess(data.user)) return null;
    return data.user;
  } catch (e) {
    window.location.href = '/index.html';
    return null;
  }
}

function permissionGranted(user, required) {
  return required.every((permission) => (user.permissions || []).includes(permission));
}

function permissionAlternativeGranted(user, alternatives) {
  return alternatives.some((required) => permissionGranted(user, required));
}

function renderApplicationNav(user) {
  const nav = document.querySelector('[data-app-nav]');
  if (!nav) return;
  const permissions = user.permissions || [];
  const can = (required) => permissionGranted({ permissions }, required);
  const canAny = (alternatives) => permissionAlternativeGranted({ permissions }, alternatives);
  const path = window.location.pathname;
  const hash = window.location.hash;
  const link = (href, label, icon, visible, extra = '') => visible ?
    `<a href="${href}" class="${path + hash === href || (href === '/payroll-history.html' && path === href && !hash) || (href === '/users.html' && path === href && !hash) ? 'active' : ''}" title="${label}" ${extra}><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span></a>` : '';
  nav.innerHTML = `
    <div class="nav-section"><span>Workspace</span></div>
    ${link('/dashboard.html', 'Dashboard', '&#9638;', can(['DASHBOARD_VIEW']))}
    ${link('/employees.html', 'Employees', '&#9673;', can(['EMPLOYEE_VIEW']))}
    <div class="nav-section"><span>Payroll</span></div>
    ${link('/payroll-history.html', 'Monthly Payments', '&#9636;', canAny([['PAYROLL_VIEW', 'SALARY_VIEW'], ['PAYROLL_SELF_VIEW', 'SALARY_SELF_VIEW']]))}
    ${link('/upload-salary.html', 'Payroll Processing', '&#8593;', can(['PAYROLL_UPLOAD', 'PAYROLL_PROCESS', 'SALARY_UPDATE']))}
    ${link('/payslips.html', 'Payslips', '&#9633;', canAny([['PAYSLIP_VIEW', 'PAYSLIP_DOWNLOAD'], ['PAYSLIP_SELF_VIEW', 'PAYSLIP_SELF_DOWNLOAD']]))}
    ${link('/payroll-reports.html', 'Payroll Reports', '&#9776;', can(['PAYROLL_VIEW', 'SALARY_VIEW']))}
    <div class="nav-section"><span>Administration</span></div>
    ${link('/users.html', 'Users', '&#9823;', can(['USER_VIEW']))}
    ${link('/roles.html', 'Roles & Permissions', '&#9881;', can(['ROLE_VIEW']))}
    <div class="nav-section"><span>Oversight</span></div>
    ${link('/audit.html', 'Audit', '&#9678;', can(['AUDIT_VIEW']))}
    ${link('/settings.html', 'Settings', '&#9881;', can(['SYSTEM_CONFIGURE']))}
  `;
}

function enforcePageAccess(user) {
  const main = document.querySelector('[data-page-permission]');
  const alternateMain = document.querySelector('[data-page-permission-alternatives]');
  if (!main && !alternateMain) return true;
  const allowed = main
    ? permissionGranted(user, main.dataset.pagePermission.split(',').map((value) => value.trim()).filter(Boolean))
    : permissionAlternativeGranted(user, alternateMain.dataset.pagePermissionAlternatives.split('|').map((alternative) =>
      alternative.split('+').map((value) => value.trim()).filter(Boolean)));
  if (allowed) return true;
  const target = main || alternateMain;
  target.innerHTML = '<div class="permission-state"><h2>Permission required</h2><p>Your account does not have access to this area.</p></div>';
  return false;
}

function renderUserBox(user) {
  const nameEl = document.querySelector('[data-user-name]');
  const roleEl = document.querySelector('[data-user-role]');
  if (nameEl) nameEl.textContent = user.fullName || user.username;
  if (roleEl) roleEl.textContent = (user.roles || []).join(', ') || user.role || '';
}

function hasPermission(permission) {
  return Boolean(currentUser && (currentUser.permissions || []).includes(permission));
}

function applyPermissionVisibility(permissions) {
  const granted = new Set(permissions);
  document.querySelectorAll('[data-permission]').forEach((element) => {
    const required = element.dataset.permission.split(',').map((value) => value.trim()).filter(Boolean);
    element.hidden = !required.every((permission) => granted.has(permission));
  });
  document.querySelectorAll('[data-permission-alternatives]').forEach((element) => {
    const alternatives = element.dataset.permissionAlternatives.split('|').map((alternative) =>
      alternative.split('+').map((value) => value.trim()).filter(Boolean));
    element.hidden = !alternatives.some((required) =>
      required.every((permission) => granted.has(permission)));
  });
}

function landingPageFor(user) {
  const permissions = new Set(user.permissions || []);
  if (permissions.has('DASHBOARD_VIEW')) return '/dashboard.html';
  if (permissions.has('PAYROLL_SELF_VIEW') && permissions.has('SALARY_SELF_VIEW')) {
    return '/payroll-history.html';
  }
  return '/dashboard.html';
}

async function doLogout() {
  try { await apiFetch('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  window.location.href = '/index.html';
}

function setupSidebarToggle() {
  const btn = document.querySelector('[data-hamburger]');
  const sidebar = document.querySelector('.sidebar');
  if (!btn || !sidebar) return;
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'sidebar-collapse';
  collapseBtn.setAttribute('aria-label', 'Collapse navigation');
  collapseBtn.innerHTML = '<span aria-hidden="true">‹</span>';
  sidebar.appendChild(collapseBtn);
  const setCollapsed = (collapsed) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
    collapseBtn.innerHTML = `<span aria-hidden="true">${collapsed ? '›' : '‹'}</span>`;
    try { localStorage.setItem('portal.sidebarCollapsed', collapsed ? '1' : '0'); } catch (_) { /* storage is optional */ }
  };
  let saved = false;
  try { saved = localStorage.getItem('portal.sidebarCollapsed') === '1'; } catch (_) { /* storage is optional */ }
  setCollapsed(saved);
  collapseBtn.addEventListener('click', () => setCollapsed(!document.body.classList.contains('sidebar-collapsed')));
  btn.addEventListener('click', () => sidebar.classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (window.innerWidth > 900) return;
    if (!sidebar.contains(e.target) && !btn.contains(e.target)) sidebar.classList.remove('open');
  });
}

function fmtMoney(n) {
  const num = Number(n) || 0;
  return 'Rs. ' + num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function showAlert(container, message, type = 'error') {
  if (!container) return;
  container.innerHTML = `<div class="alert alert-${type}">${escapeHtml(message)}</div>`;
}

function clearAlert(container) {
  if (container) container.innerHTML = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
  const logoutBtn = document.querySelector('[data-logout]');
  if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
  setupSidebarToggle();
});
