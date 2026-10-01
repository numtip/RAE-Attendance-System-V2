/**
 * Release 1 API contract smoke (fixture or MariaDB via DATA_SOURCE + DB_*).
 * Fails if routes 404 or success/error envelopes break.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const userUid = '22222222-2222-2222-2222-222222222222';

function parseImplementedRoutes(markdown) {
  const start = markdown.indexOf('## Implemented');
  const end = markdown.indexOf('## Previously reserved');
  const section = start >= 0 && end > start ? markdown.slice(start, end) : markdown;
  const routes = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^\|\s*(GET|POST)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/);
    if (match) {
      routes.push({ method: match[1], template: match[2], statusHint: match[3].trim() });
    }
  }
  return routes;
}

function materializePath(template) {
  let path = template
    .replace(':employeeUid', userUid)
    .replace(':date', '2026-03-02')
    .replace(':year', '2026')
    .replace(':month', '3');
  if (template.includes('/leave/balance/')) {
    path += '?year=2026';
  }
  return path;
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function request(port, method, path, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let bodyJson = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    bodyJson = await response.json();
  }
  return { status: response.status, body: bodyJson };
}

function assertEnvelope(label, { status, body }) {
  if (status === 404) {
    throw new Error(`${label}: route returned 404`);
  }
  if (body == null || typeof body !== 'object') {
    throw new Error(`${label}: expected JSON body, got ${body}`);
  }
  if (typeof body.success !== 'boolean') {
    throw new Error(`${label}: missing success flag`);
  }
  if (body.success) {
    if (body.data === undefined) {
      throw new Error(`${label}: success response missing data`);
    }
    return;
  }
  if (!body.error || typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
    throw new Error(`${label}: failure response missing error.code/message`);
  }
}

function assertStatus(label, status, allowed) {
  if (!allowed.includes(status)) {
    throw new Error(`${label}: status ${status} not in [${allowed.join(', ')}]`);
  }
}

async function main() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'contract-smoke-secret';
  if (!process.env.DATA_SOURCE) {
    process.env.DATA_SOURCE = 'fixture';
  }

  const contractPath = join(root, 'docs', 'API_CONTRACT.md');
  const routes = parseImplementedRoutes(readFileSync(contractPath, 'utf8'));
  if (routes.length === 0) {
    console.error('contract-smoke: no routes parsed from API_CONTRACT.md');
    process.exit(1);
  }

  const { createApp } = require(join(root, 'backend', 'src', 'app.js'));
  const app = createApp();
  const { server, port } = await listen(app);

  try {
    const badLogin = await request(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'not-an-email', password: 'short' },
    });
    assertStatus('auth validation', badLogin.status, [400]);
    assertEnvelope('auth validation', badLogin);

    const login = await request(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    assertStatus('auth login', login.status, [200]);
    assertEnvelope('auth login', login);
    const accessToken = login.body.data.accessToken;
    const refreshToken = login.body.data.refreshToken;

    const me = await request(port, 'GET', '/api/v1/auth/me', { token: accessToken });
    assertStatus('auth me', me.status, [200]);
    assertEnvelope('auth me', me);
    if (me.body.data.passwordHash !== undefined) {
      throw new Error('auth me: passwordHash must be omitted');
    }

    const skipInLoop = new Set([
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      '/api/v1/auth/me',
    ]);

    const failures = [];
    for (const route of routes) {
      if (skipInLoop.has(route.template)) {
        continue;
      }
      const path = materializePath(route.template);
      const label = `${route.method} ${path}`;
      try {
        let result;
        if (route.method === 'GET') {
          const publicHealth = path.endsWith('/health');
          const ssoLogin = path.includes('/auth/sso/login');
          const ssoCallback = path.includes('/auth/sso/callback');
          const needsAuth = !publicHealth && !ssoLogin && !ssoCallback;
          result = await request(port, 'GET', path, { token: needsAuth ? accessToken : undefined });
          if (path.endsWith('/health')) {
            assertStatus(label, result.status, [200]);
          } else if (path.includes('/auth/sso/')) {
            assertStatus(label, result.status, [302, 403, 503, 401]);
          } else if (path.includes('/attendance/daily/')) {
            assertStatus(label, result.status, [200, 403]);
          } else {
            assertStatus(label, result.status, [200, 403, 404]);
          }
        } else if (route.template.includes('/auth/sso/logout')) {
          result = await request(port, 'POST', path, {
            token: accessToken,
            body: { refreshToken },
          });
          assertStatus(label, result.status, [200, 401, 403, 503]);
        } else {
          result = await request(port, 'POST', path, { token: accessToken, body: {} });
        }

        if (result.status !== 302) {
          assertEnvelope(label, result);
        }
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
      }
    }

    const refreshResult = await request(port, 'POST', '/api/v1/auth/refresh', { body: { refreshToken } });
    assertStatus('auth refresh', refreshResult.status, [200]);
    assertEnvelope('auth refresh', refreshResult);

    if (failures.length > 0) {
      console.error('contract-smoke failures:\n' + failures.join('\n'));
      process.exit(1);
    }

    console.log(`contract-smoke: ok (${routes.length} API_CONTRACT paths, DATA_SOURCE=${process.env.DATA_SOURCE})`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
