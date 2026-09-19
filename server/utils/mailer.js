const nodemailer = require('nodemailer');
const { getEmailConfig } = require('../config');

let transporter = null;
let transporterError = null;

/**
 * Lazily builds (and caches) the SMTP transporter from .env values.
 * Returns null if email sending is disabled or SMTP isn't configured —
 * callers must handle that by reporting a clear per-employee failure
 * instead of throwing, so a missing/bad SMTP setup never crashes a run.
 */
function getTransporter() {
  if (transporter) return transporter;
  if (transporterError) return null;

  if (!isEmailEnabled()) return null;

  const config = getEmailConfig();

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls,
    auth: { user: config.user, pass: config.pass },
    tls: { minVersion: 'TLSv1.2', servername: config.host }
  });

  return transporter;
}

function isEmailEnabled() {
  return getEmailConfig().enabled;
}

async function verifyConnection() {
  if (!isEmailEnabled()) throw new Error('Set EMAIL_NOTIFICATIONS_ENABLED=true before verifying SMTP.');
  const transport = getTransporter();
  if (!transport) throw new Error(transporterError || 'Email is not configured on the server.');
  await transport.verify();
  return true;
}

/**
 * Sends one email with an optional PDF attachment.
 * Never throws — always resolves to { success, error }, so callers can
 * loop over many employees and keep going even if one send fails.
 */
async function sendMail({ to, subject, text, html, attachments }) {
  if (!isEmailEnabled()) {
    return { success: false, skipped: true, error: 'Email notifications are turned off (EMAIL_NOTIFICATIONS_ENABLED is not "true" in .env).' };
  }
  if (!to) {
    return { success: false, error: 'No email address on file for this employee.' };
  }

  const transport = getTransporter();
  if (!transport) {
    return { success: false, error: transporterError || 'Email is not configured on the server.' };
  }

  const config = getEmailConfig();

  try {
    await transport.sendMail({
      from: `"${config.fromName}" <${config.fromAddress}>`,
      to,
      subject,
      text,
      html,
      attachments
    });
    return { success: true };
  } catch (err) {
    console.error('[mailer] send failed', err.message);
    return { success: false, error: err.message || 'Failed to send email.' };
  }
}

module.exports = { sendMail, isEmailEnabled, verifyConnection };
