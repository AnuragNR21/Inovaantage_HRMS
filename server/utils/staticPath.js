const path = require('path');

function resolvePublicPath(publicDir, requestPathname) {
  const decoded = decodeURIComponent(String(requestPathname || '/'));
  const candidate = path.resolve(publicDir, `.${decoded}`);
  const relative = path.relative(publicDir, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

module.exports = { resolvePublicPath };
