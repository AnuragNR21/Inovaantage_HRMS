const { handleRequest } = require('../server/server');
const db = require('../server/db');
const { validateRuntimeConfig } = require('../server/config');
const { URL } = require('node:url');

let initialization;

function initialize() {
  if (!initialization) {
    initialization = (async () => {
      validateRuntimeConfig();
      await db.initPool();
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

module.exports = async function vercelHandler(req, res) {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    const rewrittenPath = requestUrl.searchParams.get('path');
    if (requestUrl.pathname === '/api' && rewrittenPath) {
      requestUrl.pathname = `/api/${rewrittenPath.replace(/^\/+/, '')}`;
      requestUrl.searchParams.delete('path');
      req.url = `${requestUrl.pathname}${requestUrl.search}`;
    }
    await initialize();
    return handleRequest(req, res);
  } catch (error) {
    console.error('[vercel] initialization error', error);
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        success: false,
        message: 'The application backend is not configured or cannot reach its database.'
      }));
    }
  }
};
