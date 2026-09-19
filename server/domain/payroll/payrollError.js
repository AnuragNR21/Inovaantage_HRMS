class PayrollDomainError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = 'PayrollDomainError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

module.exports = { PayrollDomainError };
