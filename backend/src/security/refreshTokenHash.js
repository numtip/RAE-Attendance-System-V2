const { createHash } = require('node:crypto');

function hashRefreshToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

module.exports = { hashRefreshToken };
