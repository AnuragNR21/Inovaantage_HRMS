const crypto = require('crypto');
const authRepository = require('../repositories/authRepository');
const sessionStore = require('../utils/sessionStore');
const { getAuthConfig } = require('../config');
const { hashPassword, validatePassword, verifyPassword } = require('./passwordService');
const { sendMail, isEmailEnabled } = require('../utils/mailer');

class AuthError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function publicUser(user) {
  return {
    userId: user.USER_ID,
    username: user.USERNAME,
    fullName: user.FULL_NAME,
    role: user.ROLE,
    mustChangePassword: user.MUST_CHANGE_PASSWORD === 1
  };
}

async function login({ username, password, ipAddress, userAgent }) {
  const normalizedUsername = String(username || '').trim();
  const suppliedPassword = typeof password === 'string' ? password : '';
  if (!normalizedUsername || !suppliedPassword || normalizedUsername.length > 60) {
    throw new AuthError(400, 'AUTH_INPUT_INVALID', 'Username and password are required.');
  }

  const config = getAuthConfig();
  const usernameHash = sha256(normalizedUsername.toLowerCase());
  const safeIp = String(ipAddress || 'unknown').slice(0, 64);
  const since = new Date(Date.now() - config.attemptWindowMinutes * 60 * 1000);
  const counts = await authRepository.getRecentFailureCounts(usernameHash, safeIp, since);
  if (counts.username >= config.maxFailedAttempts || counts.ip >= config.maxFailedAttempts * 5) {
    throw new AuthError(429, 'AUTH_RATE_LIMITED', 'Too many login attempts. Please try again later.');
  }

  const user = await authRepository.findUserByUsername(normalizedUsername);
  const passwordOk = await verifyPassword(suppliedPassword, user && user.PASSWORD_HASH);
  const locked = user && user.LOCKED_UNTIL && new Date(user.LOCKED_UNTIL).getTime() > Date.now();
  const active = user && user.IS_ACTIVE === 1;

  if (locked) {
    throw new AuthError(429, 'AUTH_RATE_LIMITED', 'Too many login attempts. Please try again later.');
  }

  if (!user || !active || !passwordOk) {
    await authRepository.recordAttempt({ usernameHash, ipAddress: safeIp, success: false });
    if (user && active && !passwordOk) {
      const nextFailureCount = Number(user.FAILED_LOGIN_COUNT || 0) + 1;
      const lockUntil = nextFailureCount >= config.maxFailedAttempts
        ? new Date(Date.now() + config.lockoutMinutes * 60 * 1000)
        : null;
      await authRepository.recordFailedLogin(user.USER_ID, lockUntil);
    }
    throw new AuthError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid username or password.');
  }

  await authRepository.recordAttempt({ usernameHash, ipAddress: safeIp, success: true });
  await authRepository.recordSuccessfulLogin(user.USER_ID);
  await authRepository.clearRecentFailures(usernameHash);
  const session = await sessionStore.createSession(user, { ipAddress: safeIp, userAgent });
  return { ...session, user: publicUser(user) };
}

async function changePassword({ session, currentPassword, newPassword, ipAddress, userAgent }) {
  const user = await authRepository.findUserById(session.userId);
  if (!user || user.IS_ACTIVE !== 1 || !await verifyPassword(currentPassword, user.PASSWORD_HASH)) {
    throw new AuthError(401, 'AUTH_CURRENT_PASSWORD_INVALID', 'Current password is incorrect.');
  }
  const errors = validatePassword(newPassword, { username: user.USERNAME });
  if (errors.length) throw new AuthError(400, 'PASSWORD_POLICY', errors.join(' '));
  if (await verifyPassword(newPassword, user.PASSWORD_HASH)) {
    throw new AuthError(400, 'PASSWORD_REUSED', 'New password must be different from the current password.');
  }

  const passwordHash = await hashPassword(newPassword, { username: user.USERNAME });
  await authRepository.updatePassword(user.USER_ID, passwordHash);
  const updatedUser = await authRepository.findUserById(user.USER_ID);
  const replacementSession = await sessionStore.createSession(updatedUser, { ipAddress, userAgent });
  return { ...replacementSession, user: publicUser(updatedUser) };
}

async function requestPasswordReset({ username, ipAddress }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername || normalizedUsername.length > 60) return;
  const user = await authRepository.findUserByUsername(normalizedUsername);
  if (!user || user.IS_ACTIVE !== 1 || !user.RECOVERY_EMAIL || !isEmailEnabled()) return;
  if (await authRepository.hasActivePasswordResetToken(user.USER_ID)) return;

  const config = getAuthConfig();
  const token = crypto.randomBytes(32).toString('base64url');
  await authRepository.createPasswordResetToken({
    tokenHash: sha256(token),
    userId: user.USER_ID,
    expiresAt: new Date(Date.now() + config.resetTokenMinutes * 60 * 1000),
    requestedIp: String(ipAddress || 'unknown').slice(0, 64)
  });

  const resetUrl = `${config.appBaseUrl}/reset-password.html#token=${encodeURIComponent(token)}`;
  const sendResult = await sendMail({
    to: user.RECOVERY_EMAIL,
    subject: 'Payroll Portal password reset',
    text: `A password reset was requested for your account. Open this link within ${config.resetTokenMinutes} minutes:\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `<p>A password reset was requested for your account.</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in ${config.resetTokenMinutes} minutes. If you did not request this, ignore this email.</p>`
  });
  if (!sendResult.success) await authRepository.invalidatePasswordResetToken(sha256(token));
}

async function resetPassword({ token, newPassword }) {
  if (!token || typeof token !== 'string' || token.length > 200) {
    throw new AuthError(400, 'RESET_TOKEN_INVALID', 'Reset link is invalid or expired.');
  }
  const tokenHash = sha256(token);
  const user = await authRepository.findPasswordResetUser(tokenHash);
  if (!user) throw new AuthError(400, 'RESET_TOKEN_INVALID', 'Reset link is invalid or expired.');
  const errors = validatePassword(newPassword, { username: user.USERNAME });
  if (errors.length) throw new AuthError(400, 'PASSWORD_POLICY', errors.join(' '));
  const passwordHash = await hashPassword(newPassword, { username: user.USERNAME });
  const consumed = await authRepository.consumePasswordResetToken(tokenHash, passwordHash);
  if (!consumed) throw new AuthError(400, 'RESET_TOKEN_INVALID', 'Reset link is invalid or expired.');
}

module.exports = { AuthError, login, changePassword, requestPasswordReset, resetPassword, sha256 };
