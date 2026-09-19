require('dotenv').config();
const { validateRuntimeConfig, getEmailConfig } = require('../server/config');
const { verifyConnection } = require('../server/utils/mailer');

async function main() {
  validateRuntimeConfig();
  const config = getEmailConfig();
  console.log(`Verifying SMTP connection to ${config.host}:${config.port} as ${config.user}...`);
  await verifyConnection();
  console.log('SMTP authentication and TLS verification succeeded. No email was sent.');
}

main().catch((err) => {
  console.error(`SMTP verification failed: ${err.message}`);
  process.exitCode = 1;
});
