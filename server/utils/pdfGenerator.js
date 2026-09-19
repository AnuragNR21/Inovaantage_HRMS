const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { amountInWords } = require('./numberToWords');

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const COLORS = {
  ink: '#121C2A', header: '#14191F', accent: '#F26A2E', muted: '#5E6B7D',
  line: '#D8DEE6', panel: '#F3F5F7', white: '#FFFFFF'
};
const DEFAULT_LOGO_PATH = path.join(__dirname, '..', 'assets', 'inovaantage-logo.png');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  const amount = number(value);
  return `Rs. ${amount.toLocaleString('en-IN', {
    minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2
  })}`;
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function maskValue(value, visibleCharacters, prefix) {
  const normalized = String(value || '').replace(/\s+/g, '');
  return normalized ? `${prefix}${normalized.slice(-visibleCharacters)}` : '-';
}

function maskBankAccount(value) { return maskValue(value, 4, 'XXXXXX'); }
function maskPan(value) { return maskValue(value, 5, 'XXXXX'); }

function companyConfiguration() {
  const configuredLogo = String(process.env.COMPANY_LOGO_PATH || '').trim();
  const logoPath = configuredLogo
    ? (path.isAbsolute(configuredLogo) ? configuredLogo : path.resolve(process.cwd(), configuredLogo))
    : DEFAULT_LOGO_PATH;
  return {
    name: process.env.COMPANY_NAME || 'INOVAANTAGE SYSTEMS PVT LTD',
    tagline: process.env.COMPANY_TAGLINE || 'Stay Digitally Ahead With Us',
    email: String(process.env.COMPANY_EMAIL || '').trim(),
    website: String(process.env.COMPANY_WEBSITE || '').trim(),
    location: String(process.env.COMPANY_LOCATION || '').trim(),
    logoPath: fs.existsSync(logoPath) ? logoPath : null
  };
}

function dynamicAmountRows(source, definitions, fallbackLabel, fallbackValue) {
  const rows = definitions.filter(([, key]) => number(source[key]) !== 0)
    .map(([label, key]) => ({ label, amount: number(source[key]) }));
  if (!rows.length && number(fallbackValue) !== 0) {
    rows.push({ label: fallbackLabel, amount: number(fallbackValue) });
  }
  return rows;
}

function buildPayslipViewModel(payroll, employee, options = {}) {
  const period = `${MONTH_NAMES[number(payroll.PAY_MONTH)] || ''} ${payroll.PAY_YEAR || ''}`.trim();
  return {
    company: companyConfiguration(), generatedOn: options.generatedAt || new Date(), period,
    employeeDetails: [
      ['Employee Code', employee.EMPLOYEE_CODE || '-'], ['Name', employee.FULL_NAME || '-'],
      ['Department', employee.DEPARTMENT || '-'], ['Designation', employee.DESIGNATION || '-'],
      ['Bank A/C', maskBankAccount(employee.BANK_ACCOUNT)], ['Bank', employee.BANK_NAME || '-'],
      ['IFSC', employee.IFSC_CODE || '-'], ['PAN No', maskPan(employee.PAN_NO)],
      ['Period', period.toUpperCase() || '-']
    ],
    attendance: [
      ['WORKING DAYS', payroll.WORKING_DAYS], ['PRESENT', payroll.PRESENT_DAYS],
      ['ABSENT', payroll.ABSENT_DAYS], ['PAID LEAVE', payroll.PAID_LEAVE_DAYS],
      ['LOP DAYS', payroll.LOP_DAYS], ['HALF DAYS', payroll.HALF_DAYS],
      ['LATE MARKS', payroll.LATE_MARKS], ['OT HOURS', payroll.OT_HOURS]
    ].filter(([, value]) => value !== null && value !== undefined && value !== ''),
    earnings: dynamicAmountRows(payroll, [
      ['Basic Salary', 'BASIC_SALARY'], ['HRA', 'HRA'], ['DA', 'DA'],
      ['Conveyance', 'CONVEYANCE'], ['Medical Allowance', 'MEDICAL_ALLOWANCE'],
      ['Special Allowance', 'SPECIAL_ALLOWANCE'], ['Professional Development', 'PROFESSIONAL_DEVELOPMENT'],
      ['Other Allowance', 'OTHER_ALLOWANCE'], ['Food Allowance', 'FOOD_ALLOWANCE'],
      ['Bonus', 'BONUS'], ['Other Earnings', 'OTHER_EARNINGS']
    ], 'Earnings', payroll.TOTAL_EARNINGS),
    deductions: dynamicAmountRows(payroll, [
      ['Provident Fund (EPF)', 'PROVIDENT_FUND'], ['ESI', 'ESI'],
      ['Professional Tax (PT)', 'PROFESSIONAL_TAX'], ['Income Tax (TDS)', 'INCOME_TAX'],
      ['Other Deductions', 'OTHER_DEDUCTIONS']
    ], 'Deductions', payroll.TOTAL_DEDUCTIONS),
    totalEarnings: number(payroll.TOTAL_EARNINGS), totalDeductions: number(payroll.TOTAL_DEDUCTIONS),
    netSalary: number(payroll.NET_SALARY), amountInWords: amountInWords(payroll.NET_SALARY),
    remarks: String(payroll.REMARKS || '').trim()
  };
}

function drawHeader(doc, model, x, y, width) {
  const height = 78;
  doc.rect(x, y, width, height).fill(COLORS.header);
  doc.rect(x, y + height - 2, width, 2).fill(COLORS.accent);
  if (model.company.logoPath) {
    doc.image(model.company.logoPath, x + 18, y + 15, { fit: [235, 49], align: 'left', valign: 'center' });
  } else {
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(18)
      .text('INOVAANTAGE', x + 18, y + 19, { width: 235 });
    doc.fillColor('#D4D8DE').font('Helvetica').fontSize(7)
      .text(model.company.tagline.toUpperCase(), x + 18, y + 46, { width: 235, characterSpacing: 1.4 });
  }
  const detailX = x + width * 0.61;
  doc.moveTo(detailX - 13, y + 18).lineTo(detailX - 13, y + 59).lineWidth(0.7).stroke('#77808A');
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(9.5)
    .text(model.company.name, detailX, y + 16, { width: width * 0.36, ellipsis: true });
  const companyLines = [model.company.location, model.company.website, model.company.email].filter(Boolean);
  doc.fillColor('#D4D8DE').font('Helvetica').fontSize(7.5)
    .text(companyLines.join('\n'), detailX, y + 31, { width: width * 0.36, lineGap: 2 });
  return y + height;
}

function drawSectionHeading(doc, title, x, y, width) {
  doc.rect(x, y, width, 22).fill(COLORS.panel);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9.5)
    .text(title, x + 11, y + 6, { characterSpacing: 0.7 });
  return y + 22;
}

function drawEmployeeDetails(doc, details, x, y, width) {
  const rows = [[details[0], details[1]], [details[2], details[3]], [details[4], details[5]],
    [details[6], details[7]], [details[8], null]];
  const half = width / 2; const rowHeight = 17;
  const contentY = drawSectionHeading(doc, 'EMPLOYEE DETAILS', x, y, width) + 9;
  doc.rect(x, y, width, 22 + 9 + rows.length * rowHeight + 7).lineWidth(0.6).stroke(COLORS.line);
  doc.moveTo(x + half, contentY).lineTo(x + half, contentY + rows.length * rowHeight - 1).stroke(COLORS.line);
  rows.forEach((columns, rowIndex) => columns.forEach((entry, columnIndex) => {
    if (!entry) return;
    const columnX = x + columnIndex * half + 11;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(entry[0], columnX, contentY + rowIndex * rowHeight, { width: 88 });
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8.2)
      .text(String(entry[1]), columnX + 90, contentY + rowIndex * rowHeight,
        { width: half - 108, ellipsis: true });
  }));
  return y + 22 + 9 + rows.length * rowHeight + 7;
}

function drawAttendance(doc, attendance, x, y, width) {
  const headingBottom = drawSectionHeading(doc, 'ATTENDANCE SUMMARY', x, y, width);
  const height = 46;
  doc.rect(x, y, width, 22 + height).lineWidth(0.6).stroke(COLORS.line);
  if (!attendance.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text('Attendance data is not available for this payroll period.', x + 11, headingBottom + 16);
    return headingBottom + height;
  }
  const cellWidth = width / attendance.length;
  attendance.forEach(([label, value], index) => {
    const cellX = x + index * cellWidth;
    if (index) doc.moveTo(cellX, headingBottom + 10).lineTo(cellX, headingBottom + 37).stroke(COLORS.line);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(11)
      .text(String(value), cellX, headingBottom + 9, { width: cellWidth, align: 'center' });
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.2)
      .text(label, cellX + 2, headingBottom + 27, { width: cellWidth - 4, align: 'center' });
  });
  return headingBottom + height;
}

function drawAmountTable(doc, x, y, width, title, rows, totalLabel, totalValue, height) {
  const titleHeight = 23; const columnHeight = 19; const totalHeight = 24;
  const contentBottom = y + height - totalHeight;
  doc.rect(x, y, width, height).lineWidth(0.6).stroke(COLORS.line);
  doc.rect(x, y, width, titleHeight).fill(COLORS.panel);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9.5)
    .text(title, x + 11, y + 6, { characterSpacing: 0.7 });
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5)
    .text('Component', x + 11, y + titleHeight + 6, { width: width - 110 });
  doc.text('Amount (Rs.)', x + width - 98, y + titleHeight + 6, { width: 87, align: 'right' });
  doc.moveTo(x, y + titleHeight + columnHeight).lineTo(x + width, y + titleHeight + columnHeight).stroke(COLORS.line);
  let rowY = y + titleHeight + columnHeight + 5;
  rows.forEach((row) => {
    if (rowY + 15 > contentBottom) return;
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.8)
      .text(row.label, x + 11, rowY, { width: width - 105, ellipsis: true });
    doc.text(number(row.amount).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
      x + width - 91, rowY, { width: 80, align: 'right' });
    rowY += 15;
  });
  doc.rect(x, contentBottom, width, totalHeight).fill(COLORS.panel);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8.2)
    .text(totalLabel, x + 11, contentBottom + 7, { width: width - 105 });
  doc.fontSize(10).text(number(totalValue).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
    x + width - 91, contentBottom + 6, { width: 80, align: 'right' });
}

function drawNetSalary(doc, model, x, y, width) {
  const height = 57;
  doc.roundedRect(x, y, width, height, 4).fill(COLORS.ink);
  doc.rect(x, y, 4, height).fill(COLORS.accent);
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(10).text('NET SALARY PAYABLE', x + 17, y + 12);
  doc.fillColor('#E3E7EC').font('Helvetica').fontSize(7.7)
    .text(`In Words: ${model.amountInWords}`, x + 17, y + 31, { width: width * 0.62, ellipsis: true });
  const dividerX = x + width * 0.69;
  doc.moveTo(dividerX, y + 10).lineTo(dividerX, y + height - 10).lineWidth(0.6).stroke('#84909D');
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(17)
    .text(money(model.netSalary), dividerX + 10, y + 18,
      { width: width - (dividerX - x) - 23, align: 'right' });
  return y + height;
}

function drawFooter(doc, model, x, width) {
  const y = doc.page.height - 46;
  doc.moveTo(x, y).lineTo(x + width, y).lineWidth(1).stroke(COLORS.accent);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(7.5)
    .text(model.company.name, x + 10, y + 10, { width: width * 0.48, ellipsis: true });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
    .text(model.company.tagline, x + 10, y + 22, { width: width * 0.48, ellipsis: true });
  const contacts = [model.company.website, model.company.email, model.company.location].filter(Boolean).join('  |  ');
  if (contacts) doc.text(contacts, x + width * 0.48, y + 15, { width: width * 0.5 - 10, align: 'right', ellipsis: true });
}

/** Render a dynamic, A4 payslip to any writable stream. */
function generatePayslipPdf(payroll, employee, output, options = {}) {
  const model = buildPayslipViewModel(payroll, employee, options);
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: {
    Title: `Salary Slip - ${model.period}`, Author: model.company.name, Subject: 'Confidential payroll document'
  } });
  doc.pipe(output);
  const x = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = drawHeader(doc, model, x, doc.page.margins.top, width) + 15;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(21).text('Salary Slip', x + 10, y);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10)
    .text(model.period.toUpperCase(), x + 10, y + 28, { characterSpacing: 2.3 });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
    .text('Generated On', x, y + 5, { width: width - 10, align: 'right' });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8.5)
    .text(formatDate(model.generatedOn), x, y + 18, { width: width - 10, align: 'right' });
  y += 55;
  y = drawEmployeeDetails(doc, model.employeeDetails, x, y, width) + 11;
  y = drawAttendance(doc, model.attendance, x, y, width) + 11;
  const gap = 14; const tableWidth = (width - gap) / 2;
  const longestTable = Math.max(model.earnings.length, model.deductions.length, 1);
  const tableHeight = Math.max(116, 23 + 19 + longestTable * 15 + 24 + 9);
  const trailingHeight = 11 + 57 + 10 + (model.remarks ? 47 : 9) + 77;
  if (y + tableHeight + trailingHeight > doc.page.height - doc.page.margins.bottom) {
    drawFooter(doc, model, x, width);
    doc.addPage();
    y = drawHeader(doc, model, x, doc.page.margins.top, width) + 15;
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8)
      .text('SALARY SLIP - CONTINUED', x + 10, y);
    y += 22;
  }
  drawAmountTable(doc, x, y, tableWidth, 'EARNINGS', model.earnings, 'Total Earnings', model.totalEarnings, tableHeight);
  drawAmountTable(doc, x + tableWidth + gap, y, tableWidth, 'DEDUCTIONS', model.deductions, 'Total Deductions', model.totalDeductions, tableHeight);
  y += tableHeight + 11;
  y = drawNetSalary(doc, model, x, y, width) + 10;
  if (model.remarks) {
    doc.rect(x, y, width, 38).fill(COLORS.panel);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text('Remarks', x + 16, y + 8);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
      .text(model.remarks, x + 16, y + 20, { width: width - 32, ellipsis: true });
    y += 47;
  } else y += 9;
  const signatureY = Math.min(y + 24, doc.page.height - 77);
  doc.moveTo(x + 5, signatureY).lineTo(x + 145, signatureY).lineWidth(0.6).stroke(COLORS.muted);
  doc.moveTo(x + width - 145, signatureY).lineTo(x + width - 5, signatureY).stroke(COLORS.muted);
  doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.5)
    .text('Employee Signature', x + 5, signatureY + 7, { width: 140, align: 'center' })
    .text('Authorized Signatory', x + width - 145, signatureY + 7, { width: 140, align: 'center' });
  drawFooter(doc, model, x, width);
  doc.end();
}

module.exports = { generatePayslipPdf, buildPayslipViewModel, maskBankAccount, maskPan, money, formatDate };
