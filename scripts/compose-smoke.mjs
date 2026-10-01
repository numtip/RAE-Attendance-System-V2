/**
 * Full-stack smoke: frontend nginx proxy -> backend -> MariaDB.
 * Requires stack up (deploy/docker-compose.yml).
 */
const baseUrl = (process.env.COMPOSE_FRONTEND_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const userUid = '22222222-2222-2222-2222-222222222222';

async function request(method, path, { token, body } = {}) {
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

function assertOk(label, result, allowed = [200]) {
  if (!allowed.includes(result.status)) {
    throw new Error(`${label}: status ${result.status}`);
  }
  if (!result.body?.success) {
    throw new Error(`${label}: ${result.body?.error?.code || 'not success'}`);
  }
}

async function waitForHealth(maxMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${baseUrl}/api/v1/health`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('compose-smoke: health never became ready');
}

async function main() {
  await waitForHealth();

  const login = await request('POST', '/api/v1/auth/login', {
    body: { email: 'user@example.test', password: 'valid-pass' },
  });
  assertOk('login', login);
  const token = login.body.data.accessToken;
  const refresh = login.body.data.refreshToken;

  assertOk('me', await request('GET', '/api/v1/auth/me', { token }));
  assertOk('employees', await request('GET', '/api/v1/employees', { token }));
  assertOk('employee detail', await request('GET', `/api/v1/employees/${userUid}`, { token }));
  assertOk(
    'employee attendance',
    await request('GET', `/api/v1/employees/${userUid}/attendance`, { token }),
  );
  assertOk(
    'monthly',
    await request('GET', `/api/v1/attendance/monthly/${userUid}/2026/3`, { token }),
  );
  assertOk('leave list', await request('GET', '/api/v1/leave', { token }));
  assertOk(
    'leave balance',
    await request('GET', `/api/v1/leave/balance/${userUid}?year=2026`, { token }),
  );
  assertOk(
    'leave history',
    await request('GET', `/api/v1/leave/history/${userUid}`, { token }),
  );

  const refreshed = await request('POST', '/api/v1/auth/refresh', { body: { refreshToken: refresh } });
  assertOk('refresh', refreshed);

  const backendBase = (process.env.COMPOSE_BACKEND_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
  const db = await fetch(`${backendBase}/api/v1/health/db`);
  const dbJson = await db.json();
  if (!db.ok || dbJson?.data?.status !== 'connected') {
    throw new Error('compose-smoke: backend DB health not connected');
  }

  console.log('compose-smoke: ok (Release 1 paths via frontend proxy)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
