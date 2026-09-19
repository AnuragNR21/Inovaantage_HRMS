const { URL } = require('url');

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function applySecurityHeaders(res) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  };
  for (const [name, value] of Object.entries(headers)) {
    if (!res.getHeader(name)) res.setHeader(name, value);
  }
}

function isStateChangingMethod(method) {
  return STATE_CHANGING_METHODS.has(String(method || '').toUpperCase());
}

function isSameOriginRequest(req, appBaseUrl) {
  const origin = req.headers && req.headers.origin;
  const referer = req.headers && req.headers.referer;
  if (!origin && !referer) return true;
  try {
    const expected = new URL(appBaseUrl).origin;
    const actual = origin ? new URL(origin).origin : new URL(referer).origin;
    return actual === expected;
  } catch (_) {
    return false;
  }
}

module.exports = { applySecurityHeaders, isStateChangingMethod, isSameOriginRequest };
