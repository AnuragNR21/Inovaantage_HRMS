const { sendJson } = require('../utils/http');
const { getSystemConfig } = require('../config');

function getConfiguration(req, res) {
  return sendJson(res, 200, {
    success: true,
    configuration: getSystemConfig()
  });
}

module.exports = { getConfiguration };
