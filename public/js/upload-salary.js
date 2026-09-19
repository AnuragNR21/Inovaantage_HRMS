const alertBox = document.getElementById('alertBox');
const resultBox = document.getElementById('resultBox');
const dropzone = document.getElementById('dropzone');
const dropzoneText = document.getElementById('dropzoneText');
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const payMonthSelect = document.getElementById('payMonth');
const payYearInput = document.getElementById('payYear');
const requireAllInput = document.getElementById('requireAllEmployees');
const importsBody = document.getElementById('importsTableBody');

let selectedFiles = [];
let previewToken = null;
let previewConflicts = [];

(async () => { if (!await requireLogin()) return; await loadImports(); })();
document.getElementById('refreshImportsBtn').addEventListener('click', loadImports);

payMonthSelect.innerHTML = MONTH_NAMES.slice(1).map((month, index) =>
  `<option value="${index + 1}">${month}</option>`).join('');
const now = new Date();
payMonthSelect.value = now.getMonth() + 1;
payYearInput.value = now.getFullYear();

function invalidatePreview() {
  previewToken = null;
  previewConflicts = [];
  resultBox.innerHTML = '';
}

function renderConflictManager(conflicts) {
  if (!conflicts.length) return '';
  return `<div class="duplicate-manager">
    <div class="alert alert-warning"><strong>${conflicts.length} existing employee record${conflicts.length === 1 ? '' : 's'} found.</strong> Choose which version to keep. No record is changed until import confirmation.</div>
    ${conflicts.map((conflict) => `<fieldset class="duplicate-choice">
      <legend>${escapeHtml(conflict.employeeCode)} - ${escapeHtml(conflict.employeeName)}</legend>
      <label><input type="radio" name="resolution-${escapeHtml(conflict.employeeCode)}" value="EXISTING">
        <span><strong>Keep existing</strong><small>${escapeHtml(conflict.existing.sourceFile)} | Earnings ${money(conflict.existing.totalEarnings)} | Deductions ${money(conflict.existing.totalDeductions)} | Net ${money(conflict.existing.netSalary)}</small></span>
      </label>
      <label><input type="radio" name="resolution-${escapeHtml(conflict.employeeCode)}" value="UPLOADED">
        <span><strong>Use uploaded</strong><small>${escapeHtml(conflict.uploaded.sourceFile)} | Earnings ${money(conflict.uploaded.totalEarnings)} | Deductions ${money(conflict.uploaded.totalDeductions)} | Net ${money(conflict.uploaded.netSalary)}</small></span>
      </label>
    </fieldset>`).join('')}
  </div>`;
}

function renderDuplicateFiles(files) {
  if (!files.length) return '';
  return `<fieldset class="duplicate-choice duplicate-file-choice">
    <legend>Identical workbook already uploaded</legend>
    <p class="muted">The same workbook hash already exists. Choose whether to keep the existing upload or replace it.</p>
    <label><input type="radio" name="duplicate-file-decision" value="EXISTING"><span><strong>Keep existing file</strong><small>${files.map((file) => `${escapeHtml(file.sourceFile)} (#${file.importId})`).join(', ')}</small></span></label>
    <label><input type="radio" name="duplicate-file-decision" value="UPLOADED"><span><strong>Use uploaded copy</strong><small>Replace the existing workbook data with this upload.</small></span></label>
  </fieldset>`;
}

payMonthSelect.addEventListener('change', invalidatePreview);
payYearInput.addEventListener('input', invalidatePreview);
requireAllInput.addEventListener('change', invalidatePreview);
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  if (event.dataTransfer.files.length) handleFiles(event.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFiles(fileInput.files);
});

function handleFiles(fileList) {
  invalidatePreview();
  const files = [...fileList];
  if (files.some((file) => !/\.xlsx$/i.test(file.name))) {
    selectedFiles = [];
    uploadBtn.disabled = true;
    showAlert(alertBox, 'Only .xlsx salary workbooks are accepted.');
    return;
  }
  if (files.some((file) => file.size > 10 * 1024 * 1024)) {
    selectedFiles = [];
    uploadBtn.disabled = true;
    showAlert(alertBox, 'The salary workbook must not exceed 10 MB.');
    return;
  }
  clearAlert(alertBox);
  selectedFiles = files;
  dropzone.classList.add('has-file');
  dropzoneText.innerHTML = `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} selected:<br><strong>${selectedFiles.map((file) => escapeHtml(file.name)).join('<br>')}</strong><br><small>Click to choose a different set of files</small>`;
  uploadBtn.disabled = false;
}

function summaryItem(label, value, className = '') {
  return `<div class="import-stat ${className}"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderDiagnostics(summary) {
  const messages = [];
  for (const issue of summary.errors || []) {
    const label = issue.identifier ? ` (${escapeHtml(issue.identifier)})` : '';
    messages.push(`Row ${issue.row}${label}: ${issue.errors.map(escapeHtml).join('; ')}`);
  }
  for (const warning of summary.warnings || []) messages.push(escapeHtml(warning));
  if (summary.missingEmployeeIdentifiers && summary.missingEmployeeIdentifiers.length) {
    messages.push(`Missing active employees: ${summary.missingEmployeeIdentifiers.map(escapeHtml).join(', ')}`);
  }
  if (!messages.length) return '';
  const truncated = summary.diagnosticsTruncated
    ? '<p>Additional diagnostics were omitted from this preview.</p>' : '';
  return `<div class="import-diagnostics"><strong>Validation details</strong><ul>${messages.map((message) => `<li>${message}</li>`).join('')}</ul>${truncated}</div>`;
}

function money(value) {
  return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderPreviewRows(rows, totalRows) {
  if (!rows.length) return '';
  const body = rows.map((row) => `<tr>
    <td>${row.row}</td><td>${escapeHtml(row.employeeCode)}</td><td>${escapeHtml(row.employeeName)}</td>
    <td class="numeric">${money(row.totalEarnings)}</td><td class="numeric">${money(row.totalDeductions)}</td>
    <td class="numeric">${money(row.netSalary)}</td>
  </tr>`).join('');
  const note = totalRows > rows.length ? `<p class="import-note">Showing the first ${rows.length} validated rows.</p>` : '';
  return `<div class="table-wrap import-preview-table"><table><thead><tr>
    <th>Row</th><th>Employee</th><th>Name</th><th>Earnings</th><th>Deductions</th><th>Net salary</th>
  </tr></thead><tbody>${body}</tbody></table></div>${note}`;
}

function renderPreview(data) {
  const summary = data.summary;
  const statusClass = data.readyForImport ? 'alert-success' : 'alert-error';
  const statusText = data.readyForImport
    ? 'Validation passed. Review the summary before confirming the import.'
    : 'Validation failed. Nothing has been imported.';
  resultBox.innerHTML = `
    <div class="alert ${statusClass}">${statusText}</div>
    <div class="import-summary">
      ${summaryItem('Total rows', summary.totalRows)}
      ${summaryItem('Valid rows', summary.validRows, 'valid')}
      ${summaryItem('Invalid rows', summary.invalidRows, summary.invalidRows ? 'invalid' : '')}
      ${summaryItem('Duplicate rows', summary.duplicateRows, summary.duplicateRows ? 'invalid' : '')}
      ${summaryItem('Existing conflicts', summary.existingEmployeeConflicts || 0, summary.existingEmployeeConflicts ? 'warning' : '')}
      ${summaryItem('Duplicate files', summary.duplicateFiles || 0, summary.duplicateFiles ? 'warning' : '')}
      ${summaryItem('Unknown employees', summary.unknownEmployees, summary.unknownEmployees ? 'invalid' : '')}
      ${summaryItem('Missing employees', summary.missingEmployees, summary.missingEmployees ? 'warning' : '')}
      ${summaryItem('Warnings', (summary.warnings || []).length, summary.warnings.length ? 'warning' : '')}
    </div>
    ${renderDiagnostics(summary)}
    ${renderDuplicateFiles(data.duplicateFiles || [])}
    ${renderConflictManager(data.conflicts || [])}
    ${renderPreviewRows(data.rows || [], summary.validRows)}
    ${data.readyForImport ? `<button class="btn btn-primary btn-block" id="confirmImportBtn" ${data.requiresResolution ? 'disabled' : ''}>Confirm transactional import</button>` : ''}
  `;
  if (data.readyForImport) {
    previewToken = data.previewToken;
    previewConflicts = data.conflicts || [];
    resultBox.querySelectorAll('.duplicate-choice input').forEach((input) => input.addEventListener('change', updateConfirmAvailability));
    document.getElementById('confirmImportBtn').addEventListener('click', confirmImport);
  }
}

function selectedDuplicateFileDecision() {
  return resultBox.querySelector('input[name="duplicate-file-decision"]:checked')?.value || '';
}

function selectedResolutions() {
  return Object.fromEntries(previewConflicts.map((conflict) => {
    const selected = resultBox.querySelector(`input[name="resolution-${CSS.escape(conflict.employeeCode)}"]:checked`);
    return [conflict.employeeCode, selected ? selected.value : null];
  }));
}

function updateConfirmAvailability() {
  const button = document.getElementById('confirmImportBtn');
  if (!button) return;
  const resolutions = selectedResolutions();
  const needsFileDecision = resultBox.querySelectorAll('input[name="duplicate-file-decision"]').length > 0;
  button.disabled = previewConflicts.some((conflict) => !resolutions[conflict.employeeCode]) ||
    (needsFileDecision && !selectedDuplicateFileDecision());
}

uploadBtn.addEventListener('click', async () => {
  if (!selectedFiles.length) return;
  const selectedFile = selectedFiles[0];
  clearAlert(alertBox);
  invalidatePreview();
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Validating...';
  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('payMonth', payMonthSelect.value);
  formData.append('payYear', payYearInput.value);
  formData.append('requireAllEmployees', requireAllInput.checked ? 'true' : 'false');
  try {
    renderPreview(await apiFetch('/api/salary/upload', { method: 'POST', body: formData }));
  } catch (err) {
    showAlert(alertBox, err.message || 'The salary workbook could not be validated.');
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Validate & Preview';
  }
});

async function confirmImport() {
  if (!previewToken) return;
  const button = document.getElementById('confirmImportBtn');
  button.disabled = true;
  button.textContent = 'Importing...';
  try {
    const result = await apiFetch('/api/salary/upload/confirm', {
      method: 'POST',
      body: {
        previewToken,
        resolutions: selectedResolutions(),
        duplicateFileDecision: selectedDuplicateFileDecision()
      }
    });
    previewToken = null;
    resultBox.innerHTML = `
      <div class="alert alert-success">Payroll imported successfully. It is ready for approval.</div>
      <div class="row"><span>Payroll run</span><strong>#${result.runId}</strong></div>
      <div class="row"><span>Status</span><strong>${escapeHtml(result.status)}</strong></div>
      <div class="row"><span>Imported rows</span><strong>${result.rows || result.summary.validRows}</strong></div>
    `;
    selectedFiles.shift();
    fileInput.value = '';
    if (selectedFiles.length) {
      dropzoneText.innerHTML = `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} remaining in queue.<br><small>Resolve this file, then continue with the next one.</small>`;
      uploadBtn.disabled = false;
    } else {
      dropzone.classList.remove('has-file');
      dropzoneText.innerHTML = 'Click to choose file, or drag and drop here<br><small>.xlsx only</small>';
      uploadBtn.disabled = true;
    }
    await loadImports();
  } catch (err) {
    showAlert(alertBox, err.message || 'Payroll import failed. No salary rows were committed.');
    button.disabled = false;
    button.textContent = 'Confirm transactional import';
  }
}

async function loadImports() {
  try {
    const data = await apiFetch('/api/salary/imports');
    const imports = data.imports || [];
    if (!imports.length) {
      importsBody.innerHTML = '<tr><td colspan="6" class="empty-state">No payroll files have been uploaded.</td></tr>';
      return;
    }
    importsBody.innerHTML = imports.map((item) => {
      const editable = hasPermission('PAYROLL_DELETE') && ['IMPORTED', 'PENDING', 'FAILED', 'EXPIRED'].includes(item.STATUS);
      const lifecycle = '';
      return `<tr><td><strong>${escapeHtml(item.SOURCE_FILE)}</strong><br><span class="muted">Import #${item.IMPORT_ID}</span></td><td>${MONTH_NAMES[item.PAY_MONTH]} ${item.PAY_YEAR}</td><td>${item.PAYROLL_ROWS}</td><td>${fmtDate(item.CONFIRMED_AT || item.CREATED_AT)}</td><td><span class="badge badge-info">${escapeHtml(item.RUN_STATUS || item.STATUS)}</span></td><td>${lifecycle} ${editable ? `<button class="btn btn-danger btn-sm" type="button" data-delete-import="${item.IMPORT_ID}" data-file-name="${escapeHtml(item.SOURCE_FILE)}">Delete</button>` : '<span class="muted">No action</span>'}</td></tr>`;
    }).join('');
    importsBody.querySelectorAll('[data-delete-import]').forEach((button) => button.addEventListener('click', () => deleteImport(button)));
  } catch (err) {
    importsBody.innerHTML = '<tr><td colspan="6" class="empty-state">Uploaded files could not be loaded.</td></tr>';
  }
}

async function deleteImport(button) {
  const fileName = button.dataset.fileName;
  if (!confirm(`Delete ${fileName}? Payroll rows contributed by this file will also be removed. This cannot be undone.`)) return;
  button.disabled = true;
  button.textContent = 'Deleting...';
  try {
    const result = await apiFetch(`/api/salary/imports/${button.dataset.deleteImport}`, { method: 'DELETE' });
    showAlert(alertBox, `${fileName} deleted. ${result.removedRows} payroll row${result.removedRows === 1 ? '' : 's'} removed.`, 'success');
    await loadImports();
  } catch (err) {
    showAlert(alertBox, err.message || 'The uploaded file could not be deleted.');
    button.disabled = false;
    button.textContent = 'Delete';
  }
}
