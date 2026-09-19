const test = require('node:test');
const assert = require('node:assert/strict');
const { isSameOriginRequest, isStateChangingMethod } = require('../server/security');
const { resolvePublicPath } = require('../server/utils/staticPath');
const { applySecurityHeaders } = require('../server/security');
const { routeApi } = require('../server/router');
const { validateRuntimeConfig } = require('../server/config');

function response() {
  const headers = new Map();
  return {
    statusCode: null,
    body: '',
    getHeader: (name) => headers.get(name),
    setHeader(name, value) { headers.set(name, value); },
    writeHead(statusCode, values = {}) { this.statusCode = statusCode; Object.entries(values).forEach(([key, value]) => headers.set(key, value)); },
    end(body = '') { this.body = body; },
    headers
  };
}

test('security headers are applied centrally', () => {
  const res = response();
  applySecurityHeaders(res);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'self'/);
});

test('state-changing requests require same-origin metadata when supplied', () => {
  assert.equal(isStateChangingMethod('POST'), true);
  assert.equal(isStateChangingMethod('GET'), false);
  assert.equal(isSameOriginRequest({ headers: {} }, 'http://localhost:3000'), true);
  assert.equal(isSameOriginRequest({ headers: { origin: 'http://localhost:3000' } }, 'http://localhost:3000'), true);
  assert.equal(isSameOriginRequest({ headers: { origin: 'https://attacker.example' } }, 'http://localhost:3000'), false);
  assert.equal(isSameOriginRequest({ headers: { referer: 'https://attacker.example/form' } }, 'http://localhost:3000'), false);
});

test('router rejects cross-origin state-changing API requests', async () => {
  const res = response();
  const req = { method: 'POST', url: '/api/login', headers: { origin: 'https://attacker.example' }, socket: {} };
  assert.equal(await routeApi(req, res), true);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /CSRF_ORIGIN_INVALID/);
});

test('public path resolution rejects encoded and prefix traversal', () => {
  const publicDir = 'C:\\app\\public';
  assert.equal(resolvePublicPath(publicDir, '/index.html'), 'C:\\app\\public\\index.html');
  assert.equal(resolvePublicPath(publicDir, '/%2e%2e/server.js'), null);
  assert.equal(resolvePublicPath(publicDir, '/%2e%2e%5cserver.js'), null);
});

test('inline HTML event arguments encode attacker-controlled employee values', () => {
  const value = "x');alert(1);//";
  const encoded = encodeURIComponent(value).replace(/'/g, '%27');
  assert.equal(encoded.includes("'"), false);
  assert.equal(decodeURIComponent(encoded), value);
});

function withProductionEnv(overrides, callback) {
  const names = [
    'NODE_ENV',
    'APP_BASE_URL',
    'COOKIE_SECURE',
    'DB_USER',
    'DB_PASSWORD',
    'DB_CONNECT_STRING',
    'DB_HOST',
    'DB_SERVICE_NAME',
    'OPEN_BROWSER',
    'EMAIL_NOTIFICATIONS_ENABLED',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
    'EMAIL_FROM_ADDRESS'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, {
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://hrms.example.com',
      COOKIE_SECURE: 'true',
      DB_USER: 'app_user',
      DB_PASSWORD: 'test-password',
      DB_HOST: 'db.example.com',
      DB_SERVICE_NAME: 'ORCLPDB1',
      OPEN_BROWSER: 'false',
      EMAIL_NOTIFICATIONS_ENABLED: 'false',
      ...overrides
    });
    return callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('production config rejects insecure HTTP base URLs', () => {
  assert.throws(
    () => withProductionEnv({ APP_BASE_URL: 'http://hrms.example.com' }, validateRuntimeConfig),
    /APP_BASE_URL must use HTTPS/
  );
});

test('production config rejects missing database credentials', () => {
  assert.throws(
    () => withProductionEnv({ DB_PASSWORD: '' }, validateRuntimeConfig),
    /DB_USER and DB_PASSWORD are required/
  );
});

test('production config requires SMTP settings when notifications are enabled', () => {
  assert.throws(
    () => withProductionEnv({ EMAIL_NOTIFICATIONS_ENABLED: 'true' }, validateRuntimeConfig),
    /SMTP_HOST is required/
  );
});
