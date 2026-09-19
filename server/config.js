function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boolFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (/^(true|1)$/i.test(raw)) return true;
  if (/^(false|0)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function getAuthConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    bcryptRounds: intFromEnv('AUTH_BCRYPT_ROUNDS', 12, 10, 15),
    sessionTtlMinutes: intFromEnv('SESSION_TTL_MINUTES', 120, 5, 1440),
    sessionAbsoluteTtlMinutes: intFromEnv('SESSION_ABSOLUTE_TTL_MINUTES', 720, 30, 10080),
    maxFailedAttempts: intFromEnv('AUTH_MAX_FAILED_ATTEMPTS', 5, 2, 20),
    attemptWindowMinutes: intFromEnv('AUTH_ATTEMPT_WINDOW_MINUTES', 15, 1, 1440),
    lockoutMinutes: intFromEnv('AUTH_LOCKOUT_MINUTES', 15, 1, 1440),
    resetTokenMinutes: intFromEnv('AUTH_RESET_TOKEN_MINUTES', 30, 5, 240),
    passwordMinLength: intFromEnv('AUTH_PASSWORD_MIN_LENGTH', 12, 10, 64),
    passwordMaxLength: intFromEnv('AUTH_PASSWORD_MAX_LENGTH', 72, 64, 72),
    cookieSecure: boolFromEnv('COOKIE_SECURE', isProduction),
    appBaseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
  };
}

function getPayrollImportConfig() {
  return {
    maxFileBytes: intFromEnv('PAYROLL_IMPORT_MAX_FILE_MB', 10, 1, 25) * 1024 * 1024,
    maxUncompressedBytes: intFromEnv('PAYROLL_IMPORT_MAX_UNCOMPRESSED_MB', 100, 10, 500) * 1024 * 1024,
    maxRows: intFromEnv('PAYROLL_IMPORT_MAX_ROWS', 10000, 1, 50000),
    maxColumns: intFromEnv('PAYROLL_IMPORT_MAX_COLUMNS', 100, 10, 500),
    maxSheets: intFromEnv('PAYROLL_IMPORT_MAX_SHEETS', 10, 1, 50),
    previewTtlMinutes: intFromEnv('PAYROLL_IMPORT_PREVIEW_TTL_MINUTES', 30, 5, 240),
    previewRowLimit: intFromEnv('PAYROLL_IMPORT_PREVIEW_ROW_LIMIT', 50, 10, 200),
    diagnosticLimit: intFromEnv('PAYROLL_IMPORT_DIAGNOSTIC_LIMIT', 100, 10, 500)
  };
}

function getEmailConfig() {
  const enabled = boolFromEnv('EMAIL_NOTIFICATIONS_ENABLED', false);
  const config = {
    enabled,
    host: String(process.env.SMTP_HOST || '').trim(),
    port: intFromEnv('SMTP_PORT', 587, 1, 65535),
    secure: boolFromEnv('SMTP_SECURE', false),
    requireTls: boolFromEnv('SMTP_REQUIRE_TLS', true),
    user: String(process.env.SMTP_USER || '').trim(),
    pass: String(process.env.SMTP_PASS || ''),
    fromAddress: String(process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER || '').trim(),
    fromName: String(process.env.EMAIL_FROM_NAME || process.env.COMPANY_NAME || 'Payroll').trim()
  };
  if (enabled) {
    const required = [
      ['SMTP_HOST', config.host], ['SMTP_USER', config.user],
      ['SMTP_PASS', config.pass], ['EMAIL_FROM_ADDRESS', config.fromAddress]
    ];
    const missing = required.find(([, value]) => !value);
    if (missing) throw new Error(`${missing[0]} is required when email notifications are enabled.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(config.fromAddress)) {
      throw new Error('EMAIL_FROM_ADDRESS must be a valid email address.');
    }
  }
  return config;
}

function getSystemConfig() {
  const auth = getAuthConfig();
  return {
    environment: process.env.NODE_ENV || 'development',
    sessionTtlMinutes: auth.sessionTtlMinutes,
    sessionAbsoluteTtlMinutes: auth.sessionAbsoluteTtlMinutes,
    emailNotificationsEnabled: getEmailConfig().enabled
  };
}

function validateRuntimeConfig() {
  getEmailConfig();
  if (process.env.NODE_ENV !== 'production') return;
  const auth = getAuthConfig();
  let appUrl;
  try { appUrl = new URL(auth.appBaseUrl); } catch (_) { throw new Error('APP_BASE_URL must be a valid URL in production.'); }
  if (appUrl.protocol !== 'https:') throw new Error('APP_BASE_URL must use HTTPS in production.');
  if (!auth.cookieSecure) throw new Error('COOKIE_SECURE must be true in production.');
  if (!String(process.env.DB_USER || '').trim() || !String(process.env.DB_PASSWORD || '').trim()) throw new Error('DB_USER and DB_PASSWORD are required in production.');
  if (!String(process.env.DB_CONNECT_STRING || '').trim() && (!String(process.env.DB_HOST || '').trim() || !String(process.env.DB_SERVICE_NAME || '').trim())) throw new Error('Set DB_CONNECT_STRING or DB_HOST plus DB_SERVICE_NAME in production.');
  if (String(process.env.OPEN_BROWSER || 'false').toLowerCase() === 'true') throw new Error('OPEN_BROWSER must be false in production.');
}

module.exports = { getAuthConfig, getPayrollImportConfig, getEmailConfig, getSystemConfig, validateRuntimeConfig };
