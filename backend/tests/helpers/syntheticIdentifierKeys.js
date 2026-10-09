/**
 * Test-only synthetic identifier keys (never real, never reused outside tests). Production keys come from a
 * secret manager (see docs/NATIONAL_ID_PROTECTION_POLICY.md). Require this BEFORE building fixture repositories.
 */
const { randomBytes } = require('node:crypto');

function useSyntheticIdentifierKeys(env = process.env) {
  if (!env.EMPLOYEE_IDENTIFIER_HMAC_KEY && !env.EMPLOYEE_IDENTIFIER_HMAC_KEY_FILE) {
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY = randomBytes(32).toString('base64');
    env.EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION = '1';
  }
}

useSyntheticIdentifierKeys();

module.exports = { useSyntheticIdentifierKeys };
