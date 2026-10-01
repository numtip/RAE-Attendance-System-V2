# SSO readiness (V2)

Goal: V2 SSO is **implementable and testable** without calling MJU until the callback URL is registered and confirmed.

## Canonical routes

| Method | Path |
|---|---|
| GET | `/api/v1/auth/sso/login` |
| GET | `/api/v1/auth/sso/callback` |
| GET | `/api/v1/auth/sso/me` |
| POST | `/api/v1/auth/sso/logout` |

## Legacy public bundle (2026-10-01)

Read-only check of `https://raeservice.mju.ac.th/attendance/`. Labels: **CONFIRMED** / **INFERRED** / **UNKNOWN**.

- **CONFIRMED:** SSO buttons navigate to `/attendance/api/auth/sso/login`. That URL returned HTML 200, not an upstream redirect. `/api/auth/sso/login` returned 502.
- **CONFIRMED:** Callback handling in the bundle is the query parameter `sso_token`, saved as `accessToken`. Error query values include `missing_code`, `sso_failed`, `user_not_found`, `sso_disabled`, and `sso_config_error`.
- **CONFIRMED:** Profile reload calls `GET /attendance/api/auth/sso/me` with a bearer token and cookies.
- **CONFIRMED:** Logout POSTs `/attendance/api/auth/sso/logout`, then opens `https://sso.mju.ac.th/signout.aspx`. A `cid` parameter is present. It is **not** evidence of the authorize, token, or userinfo URL, and it is not a V2 client id.
- **CONFIRMED:** Landing cards target `/app/attendance`, `/app/reports`, and `/app/employees`, and an anonymous session stays on the landing page with `?redirect=`.
- **INFERRED:** The `cid` parameter is an identifier for the sign-out page. Its OAuth meaning is not proven.
- **UNKNOWN:** MJU authorize URL, token URL, userinfo URL, scopes, claims, and the employee match key. The bundle does not implement an OAuth `state` check.

V2 still uses `/api/v1/auth/sso/login|callback|me|logout`. It does not adopt `/attendance/api/*`. The V2 callback does not accept `sso_token`.

## Confirmed facts

- Donor image (December 2025) exposes `/api/auth/sso/login`, `/callback`, `/me`, and `POST /logout` (see `SSO_REUSE_PLAN.md`).
- Production Vue bundle navigates to `/attendance/api/auth/sso/*`, which nginx serves as HTML — not usable as API.
- Donor config reads `SSO_ENABLED`, `SSO_ENDPOINT`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_CALLBACK_URL`.
- Legacy host environment also defines `SSO_AUTHORIZATION_URL`, `SSO_TOKEN_URL`, `SSO_USER_INFO_URL`, and `SSO_REDIRECT_URI`; donor code did **not** read those split URLs.
- Frontend expects SSO `me` JSON `{ success: true, data: { ...user } }`.
- V2 maps MJU identity to `employees.email` (fail closed if no row).

## Assumptions (unverified with MJU)

- OAuth2 authorization code flow with `response_type=code`.
- User info includes an email (or equivalent) suitable for employee lookup.
- Scopes `openid profile email` are sufficient (override with `SSO_SCOPES`).

## Proposed V2 callback URL

Register with MJU (exact host/path is an operator choice):

```text
{APP_URL}/api/v1/auth/sso/callback
```

Example for local V2:

```text
http://127.0.0.1:3210/api/v1/auth/sso/callback
```

Production example (placeholder until infra is chosen):

```text
https://raeservice.mju.ac.th/api/v1/auth/sso/callback
```

Do **not** reuse `/attendance/api/...` or legacy `/api/auth/sso/callback` without explicit confirmation.

## Required configuration

| Variable | Purpose |
|---|---|
| `SSO_ENABLED` | Master switch (`true` only after checklist) |
| `SSO_CALLBACK_CONFIRMED` | Operator confirms MJU registered the V2 callback |
| `SSO_AUTHORIZATION_URL` | MJU authorize endpoint |
| `SSO_TOKEN_URL` | MJU token endpoint |
| `SSO_USER_INFO_URL` | MJU userinfo endpoint |
| `SSO_CLIENT_ID` | OAuth client id |
| `SSO_CLIENT_SECRET` | OAuth secret (env only) |
| `SSO_CALLBACK_URL` | Must match registered callback exactly |
| `SSO_SCOPES` | Default `openid profile email` |
| `SSO_PROVIDER` | `http` (default) or `mock` for tests |

## Implementation status

- Adapter: `backend/src/services/ssoService.js` with injectable OAuth provider (`mock` / `http`).
- CSRF: random `state` with TTL via in-memory store (replace with shared store if multi-instance).
- Timeouts: HTTP provider aborts after 15s.
- Tokens: same access/refresh issuance as password login; access JWT includes `authMethod: sso`.
- **No real MJU HTTP calls** when `SSO_ENABLED=false` (default) or `SSO_CALLBACK_CONFIRMED=false`.

## Activation checklist

1. [ ] MJU registers `{APP_URL}/api/v1/auth/sso/callback`.
2. [ ] Confirm authorization, token, and userinfo URLs (resolve donor `SSO_ENDPOINT` vs split URLs).
3. [ ] Set all `SSO_*` env vars on the V2 host (secrets outside git).
4. [ ] Set `SSO_CALLBACK_CONFIRMED=true` only after step 1–3.
5. [ ] Set `SSO_ENABLED=true` and run contract tests against MJU **staging** if available.
6. [ ] Point frontend login to `GET /api/v1/auth/sso/login` (not `/attendance/api/...`).

## Blockers

- MJU callback registration for the V2 URL is **not confirmed**.
- Split URL env vars vs donor `SSO_ENDPOINT` contract is **unknown**.
- Until confirmed: runtime returns `SSO_DISABLED` or `SSO_NOT_READY`; HTTP provider must not be used against production MJU in CI.

## Tests

- `backend/tests/sso.test.js` — mock provider flow, gates, HTTP route redirect.
- `backend/tests/release1.test.js` — default closed SSO behavior.
