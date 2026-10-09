const { HttpError } = require('../../utils/httpError');

const DEFAULT_TIMEOUT_MS = 15_000;

function createMockOAuthProvider() {
  return {
    kind: 'mock',
    buildAuthorizationUrl({ authorizationUrl, clientId, callbackUrl, scopes, state, codeChallenge }) {
      const url = new URL(authorizationUrl);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', scopes);
      url.searchParams.set('state', state);
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    async exchangeCode({ code }) {
      if (code !== 'mock-auth-code') {
        throw new HttpError(401, 'SSO_TOKEN_ERROR', 'Authorization code is invalid');
      }
      return {
        access_token: 'mock-provider-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
      };
    },
    async fetchUserInfo() {
      return {
        email: 'user@example.test',
        sub: 'mock-mju-subject',
        citizenID: '9900000000001',
      };
    },
  };
}

function createHttpOAuthProvider({ fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!fetchImpl) {
    throw new Error('fetch is required for the HTTP OAuth provider');
  }

  async function requestJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const body = await response.text();
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider returned invalid JSON');
      }
      if (!response.ok) {
        throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider rejected the request');
      }
      return parsed;
    } catch (err) {
      if (err instanceof HttpError) {
        throw err;
      }
      if (err.name === 'AbortError') {
        throw new HttpError(504, 'SSO_PROVIDER_TIMEOUT', 'OAuth provider did not respond in time');
      }
      throw new HttpError(502, 'SSO_PROVIDER_ERROR', 'OAuth provider is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'http',
    buildAuthorizationUrl({ authorizationUrl, clientId, callbackUrl, scopes, state, codeChallenge }) {
      const url = new URL(authorizationUrl);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', scopes);
      url.searchParams.set('state', state);
      if (codeChallenge) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    async exchangeCode({ tokenUrl, clientId, clientSecret, callbackUrl, code, codeVerifier }) {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      });
      if (codeVerifier) {
        body.set('code_verifier', codeVerifier);
      }
      return requestJson(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    },
    async fetchUserInfo({ userInfoUrl, accessToken }) {
      return requestJson(userInfoUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    },
  };
}

function createOAuthProvider(config, overrides = {}) {
  if (overrides.provider) {
    return overrides.provider;
  }
  const mode = config.sso.provider || 'http';
  if (mode === 'mock') {
    return createMockOAuthProvider();
  }
  const timeoutMs = overrides.timeoutMs ?? config.sso?.httpTimeoutMs;
  return createHttpOAuthProvider({ ...overrides, timeoutMs });
}

module.exports = {
  createMockOAuthProvider,
  createHttpOAuthProvider,
  createOAuthProvider,
};
