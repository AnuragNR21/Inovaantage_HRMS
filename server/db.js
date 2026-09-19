require('dotenv').config();
const oracledb = require('oracledb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = false;
oracledb.fetchAsString = [oracledb.CLOB];
oracledb.fetchAsBuffer = [oracledb.BLOB];

function buildConnectString() {
  if (process.env.DB_CONNECT_STRING && process.env.DB_CONNECT_STRING.trim()) {
    return process.env.DB_CONNECT_STRING.trim();
  }
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '1521';
  const service = process.env.DB_SERVICE_NAME || 'orcl';
  return `${host}:${port}/${service}`;
}

let pool = null;

async function initPool() {
  if (pool) return pool;

  let candidatePool;
  let connection;
  try {
    candidatePool = await oracledb.createPool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectString: buildConnectString(),
      poolMin: parseInt(process.env.DB_POOL_MIN || '2', 10),
      poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
      poolIncrement: parseInt(process.env.DB_POOL_INCREMENT || '1', 10)
    });

    connection = await candidatePool.getConnection();
    await connection.execute('SELECT 1 AS health_check FROM DUAL');
    await connection.close();
    connection = null;

    pool = candidatePool;
    console.log(`[db] Oracle connection pool created -> ${buildConnectString()}`);
    return pool;
  } catch (err) {
    if (connection) {
      try { await connection.close(); } catch (closeErr) { console.error('[db] close error', closeErr); }
    }
    if (candidatePool) {
      try { await candidatePool.close(0); } catch (closeErr) { console.error('[db] pool close error', closeErr); }
    }
    throw err;
  }
}

async function getConnection() {
  if (!pool) await initPool();
  return pool.getConnection();
}

/**
 * Run a query/DML with automatic connection handling.
 * @param {string} sql
 * @param {object|array} binds
 * @param {object} options
 * @param {boolean} commit - commit after execution (for INSERT/UPDATE/DELETE)
 */
async function execute(sql, binds = {}, options = {}, commit = false) {
  let conn;
  try {
    conn = await getConnection();
    const result = await conn.execute(sql, binds, options);
    if (commit) await conn.commit();
    return result;
  } finally {
    if (conn) {
      try { await conn.close(); } catch (e) { console.error('[db] close error', e); }
    }
  }
}

/**
 * Run a function with a raw connection, for multi-statement transactions.
 * The caller is responsible for commit/rollback.
 */
async function withConnection(fn) {
  const conn = await getConnection();
  try {
    return await fn(conn);
  } finally {
    try { await conn.close(); } catch (e) { console.error('[db] close error', e); }
  }
}

async function closePool() {
  if (pool) {
    await pool.close(10);
    pool = null;
  }
}

function isPoolReady() {
  return Boolean(pool);
}

module.exports = { oracledb, initPool, getConnection, execute, withConnection, closePool, isPoolReady };
