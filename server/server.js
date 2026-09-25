require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { routeApi } = require('./router');
const authController = require('./controllers/authController');
const db = require('./db');
const payrollEmailWorker = require('./services/payrollEmailWorker');
const { applySecurityHeaders } = require('./security');
const { resolvePublicPath } = require('./utils/staticPath');
const { validateRuntimeConfig, getEmailConfig } = require('./config');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const PUBLIC_HTML_PATHS = new Set(['/index.html', '/reset-password.html']);

function sendHealth(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function serveStatic(req, res, requestPathname) {
  let pathname;
  try { pathname = decodeURIComponent(requestPathname); } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = resolvePublicPath(PUBLIC_DIR, pathname);

  if (!filePath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA-ish fallback: unknown .html paths -> 404 page, others -> 404
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<h1>404 - Page not found</h1><p><a href="/">Go home</a></p>');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res) {
  try {
    applySecurityHeaders(res);
    const healthPath = new URL(req.url, 'http://localhost').pathname;
    if (healthPath === '/health/live' || healthPath === '/api/health/live') return sendHealth(res, 200, { status: 'ok' });
    if (healthPath === '/health/ready' || healthPath === '/api/health/ready') {
      if (!db.isPoolReady()) return sendHealth(res, 503, { status: 'not_ready' });
      try { await db.execute('SELECT 1 AS health_check FROM DUAL'); return sendHealth(res, 200, { status: 'ready' }); }
      catch (_) { return sendHealth(res, 503, { status: 'not_ready' }); }
    }
    const handled = await routeApi(req, res);
    if (handled) return;
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const resolvedPath = pathname === '/' ? '/index.html' : pathname;
    if (resolvedPath.endsWith('.html') && !PUBLIC_HTML_PATHS.has(resolvedPath)) {
      const authenticated = await authController.authenticateRequest(req);
      if (!authenticated) {
        res.writeHead(302, { Location: '/index.html', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (authenticated.mustChangePassword && resolvedPath !== '/change-password.html') {
        res.writeHead(302, { Location: '/change-password.html', 'Cache-Control': 'no-store' });
        return res.end();
      }
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server] unhandled error', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Internal server error.' }));
    }
  }
}

const server = http.createServer(handleRequest);

async function start() {
  try {
    validateRuntimeConfig();
  } catch (err) {
    console.error('\n[FATAL] Application configuration is invalid.');
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  try {
    await db.initPool();
  } catch (err) {
    console.error('\n[FATAL] Could not connect to Oracle database.');
    console.error('Check your .env DB_USER / DB_PASSWORD / DB_HOST / DB_PORT / DB_SERVICE_NAME values.');
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  server.listen(PORT, () => {
    const openUrl = `http://localhost:${PORT}`;
    console.log(`\n  Inovaantage Payroll Portal running at ${openUrl}\n`);
    if (String(process.env.OPEN_BROWSER || 'false').toLowerCase() === 'true') {
      openInBrowser(openUrl);
    }
    if (getEmailConfig().enabled) payrollEmailWorker.start();
  });
}

/**
 * Best-effort cross-platform "open URL in default browser", no extra
 * npm dependency required. Failures are logged but never crash the server.
 */
function openInBrowser(target) {
  const { exec } = require('child_process');
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') cmd = `open "${target}"`;
  else if (platform === 'win32') cmd = `start "" "${target}"`;
  else cmd = `xdg-open "${target}"`; // linux and others

  exec(cmd, (err) => {
    if (err) {
      console.log(`(Could not auto-open browser — visit ${target} manually.)`);
    }
  });
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down...');
  await new Promise((resolve) => server.close(() => resolve()));
  await db.closePool().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) start();

module.exports = { handleRequest, start, server };
