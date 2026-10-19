const { HttpError } = require('../utils/httpError');

async function revokePresentedAccessToken(repositories, auth) {
  if (!auth?.jti) return;
  const store = repositories.accessTokenRevocations;
  if (!store || typeof store.revoke !== 'function') {
    throw new HttpError(503, 'REVOCATION_STORE_UNAVAILABLE', 'Access token revocation state is unavailable');
  }
  if (!auth.accessTokenExpiresAt) {
    throw new HttpError(503, 'REVOCATION_STORE_UNAVAILABLE', 'Access token revocation state is unavailable');
  }
  try {
    await store.revoke({ jti: auth.jti, expiresAt: auth.accessTokenExpiresAt });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'REVOCATION_STORE_UNAVAILABLE', 'Access token revocation state is unavailable');
  }
}

module.exports = { revokePresentedAccessToken };
