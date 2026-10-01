# SSO activation checklist (V2)

Operator sequence, env, live test, and rollback: [`SSO_ACTIVATION_RUNBOOK.md`](./SSO_ACTIVATION_RUNBOOK.md).

Use this document when turning on MJU SSO in production. Until every prerequisite is checked, keep **`SSO_ENABLED=false`** (default) and **`SSO_CALLBACK_CONFIRMED=false`**.

Related: [`SSO_READINESS.md`](./SSO_READINESS.md), [`SSO_REUSE_PLAN.md`](./SSO_REUSE_PLAN.md).

## Proposed production callback (register with MJU)

V2 expects the OAuth `redirect_uri` to match **`SSO_CALLBACK_URL`** exactly. For the current production host naming in legacy docs:

```text
https://raeservice.mju.ac.th/api/v1/auth/sso/callback
```

Local development example (from readiness doc):

```text
http://127.0.0.1:3210/api/v1/auth/sso/callback
```

Do **not** register or reuse `/attendance/api/auth/sso/callback` or legacy `/api/auth/sso/callback` without explicit MJU confirmation.

---

## Evidenced legacy URLs and configuration (no guessing)

### Confirmed (from donor image, bundle, or documented env **names**)

| Item | Evidence |
|------|----------|
| Donor SSO HTTP routes | `GET /api/auth/sso/login`, `GET /api/auth/sso/callback`, `GET /api/auth/sso/me`, `POST /api/auth/sso/logout` (`SSO_REUSE_PLAN.md`) |
| Production Vue bundle paths (not API) | Navigates to `/attendance/api/auth/sso/login`, `/attendance/api/auth/sso/me`, `POST /attendance/api/auth/sso/logout`; nginx serves `/attendance/` as HTML (`SSO_REUSE_PLAN.md`) |
| Legacy API host prefix (frontend) | `https://raeservice.mju.ac.th/api/...` (`docs/API_CONTRACT.md`, `docs/LEGACY_COMPONENT_ASSESSMENT.md`) |
| Donor config env vars read at runtime | `SSO_ENABLED`, `SSO_ENDPOINT`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_CALLBACK_URL` (`SSO_REUSE_PLAN.md`) |
| Legacy host env var **names** (not read by donor code) | `SSO_AUTHORIZATION_URL`, `SSO_TOKEN_URL`, `SSO_USER_INFO_URL`, `SSO_REDIRECT_URI` (`SSO_REUSE_PLAN.md`) |
| Frontend `me` response shape | `{ success: true, data: { ...user } }` (`SSO_REUSE_PLAN.md`) |
| V2 canonical routes | `GET/POST` under `/api/v1/auth/sso/*` (`SSO_READINESS.md`) |

No OAuth authorization, token, or userinfo **URL values** appear in repository documentation. Secret values are intentionally not recorded.

### Unknown / unverified (do not assume in production)

| Item | Notes |
|------|--------|
| MJU authorization endpoint URL | Not documented in repo; may relate to donor `SSO_ENDPOINT` or host split `SSO_AUTHORIZATION_URL` — relationship **not proven** (`SSO_REUSE_PLAN.md`) |
| MJU token endpoint URL | Host had `SSO_TOKEN_URL`; donor did not read it; value **not** in repo |
| MJU userinfo endpoint URL | Host had `SSO_USER_INFO_URL`; donor did not read it; value **not** in repo |
| Registered legacy callback URL | Legacy `SSO_CALLBACK_URL` / `SSO_REDIRECT_URI` values **not** recorded; not assumed to equal V2 path |
| MJU staging environment | Mentioned as optional in readiness doc; availability **not confirmed** |
| OAuth scopes required by MJU | V2 default `openid profile email` is an **assumption** (`SSO_READINESS.md`) |

---

## Activation checklist

Complete in order. Check each box only with evidence (MJU ticket, registered redirect URI, successful non-production test, etc.).

### 1. Callback registered with MJU

- [ ] MJU OAuth client allows redirect URI: `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` (or the exact URL chosen for the deploy host).
- [ ] `SSO_CALLBACK_URL` in V2 env matches the registered URI **character-for-character** (scheme, host, path, no trailing slash mismatch).

### 2. Client configuration

- [ ] `SSO_CLIENT_ID` and `SSO_CLIENT_SECRET` issued for the V2 application (not committed to git; use host secrets manager or env injection).
- [ ] Resolve URL contract with MJU: set **`SSO_AUTHORIZATION_URL`**, **`SSO_TOKEN_URL`**, **`SSO_USER_INFO_URL`** to the endpoints MJU confirms (do not copy undocumented values from legacy host without verification).
- [ ] `SSO_SCOPES` matches MJU registration (default in V2: `openid profile email`).
- [ ] `SSO_PROVIDER=http` in production (use `mock` only in tests).

### 3. Secrets and environment

- [ ] All `SSO_*` variables set on the V2 host per [`.env.example`](../.env.example) and [`SSO_READINESS.md`](./SSO_READINESS.md).
- [ ] `JWT_SECRET` and database credentials configured independently of SSO.
- [ ] `APP_URL` reflects the public origin (used for post-login redirect from callback).

### 4. TLS and network

- [ ] Public API served over HTTPS with a valid certificate for `raeservice.mju.ac.th` (or chosen host).
- [ ] Outbound HTTPS from V2 backend to MJU token and userinfo URLs allowed (firewall / egress).
- [ ] No dependency on `/attendance/api/*` paths for SSO API calls.

### 5. State / CSRF

- [ ] Understand V2 uses one-time random `state` (in-memory store; TTL 10 minutes) — see `ssoStateStore.js`.
- [ ] If running multiple API instances, plan a shared state store before production SSO (readiness doc note).

### 6. Token exchange and identity mapping tested

- [ ] With `SSO_ENABLED=true`, `SSO_CALLBACK_CONFIRMED=true`, and complete config, complete a full login on a **non-production** or staging client if MJU provides one.
- [ ] Callback exchanges `code` for tokens and loads userinfo without calling MJU from CI (contract tests use mock/`fetchImpl`).
- [ ] MJU identity email maps to an existing `employees.email` row; unknown users receive `SSO_USER_UNKNOWN` (fail closed).

### 7. Error handling verified

- [ ] Disabled: `SSO_ENABLED=false` → `403` / `SSO_DISABLED` on login.
- [ ] Not ready: missing confirmation or incomplete env → `503` / `SSO_NOT_READY`.
- [ ] Invalid or replayed `state` → `403` / `SSO_STATE_INVALID`.
- [ ] Provider timeout / HTTP errors → `504` / `SSO_PROVIDER_TIMEOUT` or `502` / `SSO_PROVIDER_ERROR`.
- [ ] User denial at IdP (`error` query param) → `401` / `SSO_DENIED`.

### 8. Enable production SSO

- [ ] Set `SSO_CALLBACK_CONFIRMED=true` only after steps 1–3 are verified.
- [ ] Set `SSO_ENABLED=true` only after steps 6–7 pass in a controlled environment.
- [ ] Frontend login uses `GET /api/v1/auth/sso/login` (not `/attendance/api/...`).

### 9. Automated contract tests (CI)

- [ ] `backend/tests/sso.test.js` passes (gates, mock flow, invalid state, provider timeout/error).
- [ ] CI does **not** set production MJU URLs or `SSO_ENABLED=true` against live MJU.

---

## V2 environment reference

| Variable | Role |
|----------|------|
| `SSO_ENABLED` | Master switch; default `false` |
| `SSO_CALLBACK_CONFIRMED` | Operator attestation that MJU registered V2 callback |
| `SSO_AUTHORIZATION_URL` | Authorize redirect target |
| `SSO_TOKEN_URL` | Authorization code exchange |
| `SSO_USER_INFO_URL` | Bearer token user profile |
| `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` | OAuth client credentials |
| `SSO_CALLBACK_URL` | Registered redirect URI |
| `SSO_SCOPES` | OAuth scopes |
| `SSO_PROVIDER` | `http` (production) or `mock` (tests) |

---

## Rollback

1. Set `SSO_ENABLED=false` (immediate gate; login returns `SSO_DISABLED`).
2. Optionally set `SSO_CALLBACK_CONFIRMED=false` to block accidental re-enable.
3. Password login and existing JWT flows remain unchanged.
