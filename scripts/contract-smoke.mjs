/**
 * Fixture-mode smoke check: every Release 1 path in docs/API_CONTRACT.md is mounted (not 404).
 * No MariaDB required. Skip in CI unless invoked explicitly:
 *   node scripts/contract-smoke.mjs
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
    const match = line.match(/^\|\s*(GET|POST)\s*\|\s*`([^`]+)`\s*\|/);
    if (match) {
      routes.push({ method: match[1], template: match[2] });
    }
  }
  return routes;
}

function materializePath(template) {
  return template
    .replace(':employeeUid', userUid)
    .replace(':date', '2026-03-02')
    .replace(':year', '2026')
    .replace(':month', '3');
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

async function main() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'contract-smoke-secret';
  process.env.DATA_SOURCE = 'fixture';

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
    const login = await request(port, 'POST', '/api/v1/auth/login', {
      body: { email: 'user@example.test', password: 'valid-pass' },
    });
    if (login.status !== 200 || !login.body?.data?.accessToken) {
      console.error('contract-smoke: login failed', login.status, login.body);
      process.exit(1);
    }
    const accessToken = login.body.data.accessToken;
    const refreshToken = login.body.data.refreshToken;

    const failures = [];
    for (const route of routes) {
      const path = materializePath(route.template);
      let result;
      if (route.method === 'GET') {
        const needsAuth = !path.endsWith('/health') && !path.includes('/auth/sso/login');
        result = await request(port, 'GET', path, { token: needsAuth ? accessToken : undefined });
      } else if (route.template === '/api/v1/auth/login') {
        result = await request(port, 'POST', path, {
          body: { email: 'user@example.test', password: 'valid-pass' },
        });
      } else if (route.template === '/api/v1/auth/refresh') {
        result = await request(port, 'POST', path, { body: { refreshToken } });
      } else if (route.template === '/api/v1/auth/logout') {
        result = await request(port, 'POST', path, {
          token: accessToken,
          body: { refreshToken },
        });
      } else if (route.template === '/api/v1/auth/sso/logout') {
        result = await request(port, 'POST', path, {
          token: accessToken,
          body: { refreshToken },
        });
      } else {
        result = await request(port, 'POST', path, { token: accessToken, body: {} });
      }

      if (result.status === 404) {
        failures.push(`${route.method} ${path} -> 404`);
      }
    }

    if (failures.length > 0) {
      console.error('contract-smoke: missing routes:\n' + failures.join('\n'));
      process.exit(1);
    }

    console.log(`contract-smoke: ok (${routes.length} API_CONTRACT paths mounted)`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
