const { PayrollDomainError } = require('./payrollError');

function requiredInteger(value, name, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PayrollDomainError(422, 'PAYROLL_INVALID', `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function createPayrollInputDto(input) {
  if (!input || !Array.isArray(input.rows) || !input.rows.length) {
    throw new PayrollDomainError(422, 'PAYROLL_INVALID', 'At least one payroll row is required.');
  }
  return Object.freeze({
    payMonth: requiredInteger(input.payMonth, 'Pay month', 1, 12),
    payYear: requiredInteger(input.payYear, 'Pay year', 2000, 2100),
    sourceFile: String(input.sourceFile || 'upload.xlsx').slice(0, 300),
    rows: input.rows.map((row) => ({ ...row })),
    parseWarnings: Array.isArray(input.parseWarnings) ? [...input.parseWarnings] : [],
    importId: input.importId == null ? null : Number(input.importId),
    replacePayrollIds: Array.isArray(input.replacePayrollIds)
      ? input.replacePayrollIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
      : [],
    actorUserId: input.actorUserId == null ? null : Number(input.actorUserId),
    actorUsername: String(input.actorUsername || 'unknown').slice(0, 60)
  });
}

module.exports = { createPayrollInputDto };
