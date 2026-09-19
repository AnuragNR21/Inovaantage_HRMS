require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../server/db');

function splitOracleScript(source) {
  const statements = [];
  let block = [];
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inBlock && /^(DECLARE|BEGIN)$/i.test(trimmed)) inBlock = true;
    if (inBlock && trimmed === '/') {
      statements.push(block.join('\n'));
      block = [];
      inBlock = false;
    } else if (!inBlock && /^COMMIT;$/i.test(trimmed)) {
      statements.push('COMMIT');
    } else if (!inBlock && trimmed.endsWith(';')) {
      block.push(line);
      statements.push(block.join('\n').replace(/;\s*$/, ''));
      block = [];
    } else if (inBlock || (trimmed && !trimmed.startsWith('--'))) {
      block.push(line);
    }
  }
  return statements;
}

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sql', '16_payroll_row_status.sql'), 'utf8');
  await db.initPool();
  await db.withConnection(async (conn) => {
    try {
      for (const statement of splitOracleScript(source)) await conn.execute(statement);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
  console.log('Payroll row status migration applied.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.closePool().catch(() => {}));
