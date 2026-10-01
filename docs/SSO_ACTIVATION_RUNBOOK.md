# SSO activation runbook

**Do not set `SSO_ENABLED=true` from this document.** Live MJU calls stay blocked until the external checklist is confirmed. CI uses the mock provider only.

Related: `docs/SSO_ACTIVATION_CHECKLIST.md`, `docs/SSO_READINESS.md`, `docs/SSO_REUSE_PLAN.md`.

## Legacy public reference (read-only)

Observed on 2026-10-01 from `https://raeservice.mju.ac.th/attendance/` and the bundle `index-78450XmL.js` / `LoginSSOView-DYfn6qI-.js` / `LandingPageView-NKtVgL6Z.js`. No legacy system was changed. Authorize, token, and userinfo URLs were not guessed.

| Behavior | Class | Evidence |
|---|---|---|
| Landing buttons | **CONFIRMED** | Header links "เข้าสู่ระบบ (SSO)" and "เข้าสู่ระบบ" point at `/attendance/api/auth/sso/login`. "เข้าสู่ระบบ (ปกติ)" and "เข้าสู่ระบบแบบปกติ" go to `/attendance/login/regular`, which shows email and password fields. Cards go to `/app/attendance`, `/app/reports`, and `/app/employees`. Without a token the browser stayed on the landing URL with `?redirect=` set to that path. |
| SSO login entry | **CONFIRMED** | `startSSOLogin` sets `window.location` to `/attendance/api/auth/sso/login`. A live GET of that URL returned **200 HTML** (the SPA). `GET /api/auth/sso/login` returned **502**. Neither response was an MJU authorize redirect. |
| Callback query | **CONFIRMED** | The bundle reads `sso_token` from the query, stores it as `localStorage.accessToken`, then strips the query. Login errors read `error` and `details`: `missing_code`, `sso_failed`, `user_not_found`, `sso_disabled`, `sso_config_error`. |
| OAuth `state` | **UNKNOWN** | The public bundle does not create or check an OAuth `state` parameter. |
| After callback, `/me` | **CONFIRMED** | `GET /attendance/api/auth/sso/me` with `Authorization: Bearer <sso_token>` and `withCredentials`. A second call omits the bearer and relies on cookies. Expected JSON is `{ success, data }`. |
| Password `/me` | **CONFIRMED** | `GET` path built as `/attendance/api/auth/me` via the same prefix helper. |
| Logout | **CONFIRMED** | Clears `localStorage`, `POST /attendance/api/auth/sso/logout` with credentials, then navigates to `https://sso.mju.ac.th/signout.aspx` with a `cid` query parameter. That legacy `cid` is not the V2 client id. |
| Identity key | **UNKNOWN** | `user_not_found` is a frontend error code. The bundle does not show whether the legacy server matches email, employee id, or another claim. |
| Frontend role checks | **CONFIRMED** as UX only | `isAdmin` is `role === "admin"`. `isManager` is admin or manager. `requiresAdmin` routes redirect to the dashboard with `error=insufficient_permissions`. This is not server enforcement. |
| Authorize / token / userinfo URLs | **UNKNOWN** | Not present in the bundle and not observed as a redirect. |

### Comparison with V2

| Step | Legacy public behavior | V2 `/api/v1/auth/sso/*` |
|---|---|---|
| Login | Browser navigates to `/attendance/api/auth/sso/login` (currently HTML) | `GET /api/v1/auth/sso/login` redirects to `SSO_SIGNIN_URL?cid=<SSO_CLIENT_ID>` when the signin URL is set, otherwise to the OAuth authorize URL. `403` while SSO is disabled |
| Callback | Query `sso_token` becomes the bearer token. No `state` in the bundle | A human V2 callback was `GET` with only `ac` (length 32, no body). Meaning is unknown. Portal mode stays `503` and issues no session |
| Me | `GET /attendance/api/auth/sso/me` | `GET /api/v1/auth/sso/me` with the V2 access token |
| Logout | POST legacy logout, then MJU `signout.aspx` | `POST /api/v1/auth/sso/logout` revokes the V2 refresh token and returns `signoutUrl` as `SSO_SIGNOUT_URL?cid=<SSO_CLIENT_ID>` |
| Identity vs authorization | Frontend role strings are UX | SSO maps an email claim onto `employees`. Data scope is a separate authorization check |

## What is known

| Item | Value | Evidence |
|---|---|---|
| V2 routes | `GET /api/v1/auth/sso/login`, `GET /api/v1/auth/sso/callback`, `GET /api/v1/auth/sso/me`, `POST /api/v1/auth/sso/logout` | `docs/SSO_READINESS.md` |
| Registered callback | `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` | **CONFIRMED** MJU registration |
| Client ID | `a46a0b5374b4404a9f71a2397dcab283` | **CONFIRMED**. Public value. Not a secret |
| Signin | `https://sso.mju.ac.th/signin.aspx?cid=<client id>` | **CONFIRMED**. Code adds only `cid` |
| Signout | `https://sso.mju.ac.th/signout.aspx?cid=<client id>` | **CONFIRMED**. After-signout URL is `https://raeservice.mju.ac.th/attendance-v2/` and is not appended |
| Donor routes | `/api/auth/sso/login`, `/callback`, `/me`, `POST /logout` | `docs/SSO_REUSE_PLAN.md` |
| Donor env names read by legacy code | `SSO_ENABLED`, `SSO_ENDPOINT`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_CALLBACK_URL` | Same doc. Values are not in git. |
| Host env names not read by donor code | `SSO_AUTHORIZATION_URL`, `SSO_TOKEN_URL`, `SSO_USER_INFO_URL`, `SSO_REDIRECT_URI` | Names only. Values are not in git. |
| Match key in V2 code | Email from `email`, else `mail`, else `preferred_username`, compared to `employees.email` | `ssoService.js`. Fail closed. |
| Disabled account | `status` other than `active` returns `403` `SSO_USER_DISABLED` | This prep change |
| Locked account | `lockedUntil` in the future returns `403` `ACCOUNT_LOCKED` | Same path as password login |

## UNKNOWN (do not guess)

| Item | Why it stays unknown |
|---|---|
| Meaning of callback field `ac` | Shape is confirmed: one query field, length 32. Not proven to be a code, token, or ticket. No public bundle or donor doc shows an exchange URL. |
| One-time use, signature, and identity claim | Not observed. Cookie name `ses_person_citizen` was present. Its value is not an identity source. |
| Token URL | Host had the env name. The value is not in the repo. |
| Userinfo URL | Host had the env name. The value is not in the repo. |
| Scopes | V2 default `openid profile email` is documented as an assumption in `SSO_READINESS.md`. |
| Client secret | Not part of the confirmed registration. Stays empty in git. |
| Required claims | Code accepts `email`, `mail`, or `preferred_username`. MJU has not confirmed which claim it sends. |
| Registered legacy callback | `SSO_CALLBACK_URL` / `SSO_REDIRECT_URI` values were not recorded. Do not assume they equal the V2 path. |
| Post-login browser path | The controller redirects to `{APP_URL}/?sso=success` and drops the tokens `handleCallback` returned. The browser does not receive an access or refresh token. How the SPA should pick up that session is **UNKNOWN** and blocks a live test. |

## Security behavior already in code

| Control | Behavior |
|---|---|
| State / CSRF | Random 24-byte hex `state`, 10 minute TTL, single `consume` (`ssoStateStore.js`). Missing, expired, or reused state is `403` `SSO_STATE_INVALID`. |
| Callback validation | `code` required. IdP `error` is `401` `SSO_DENIED`. State is checked before any token request. |
| Redirect allowlist | Login redirects only to the configured authorization URL plus OAuth query params. Success redirects only to `APP_URL`. There is no caller-supplied redirect. |
| Token handling | The provider access token is used once for userinfo and is not stored. `handleCallback` saves a new V2 refresh token and returns an access JWT, but `ssoController.callback` ignores that return value. Legacy tokens are not imported. |
| Account mapping | Lowercased email against `employees`. No row is `403` `SSO_USER_UNKNOWN`. |
| Disabled user | Non-`active` status is `SSO_USER_DISABLED`. |
| Replay | Consumed state cannot be reused. |
| Timeout / errors | HTTP provider aborts at `SSO_HTTP_TIMEOUT_MS` (default 15000). Abort is `504` `SSO_PROVIDER_TIMEOUT`. Non-OK or invalid JSON is `502` `SSO_PROVIDER_ERROR`. A 200 body without `access_token` is `502` `SSO_TOKEN_ERROR`. |
| Multi-instance | State is in process memory. More than one API process needs a shared store before live SSO. |

`SSO_ENABLED=false` returns `403` `SSO_DISABLED` before any provider call. `SSO_CALLBACK_CONFIRMED=false` or a missing URL/client field returns `503` `SSO_NOT_READY`.

## Ask MJU for

1. Confirmation that this redirect URI is registered, character for character: `https://raeservice.mju.ac.th/api/v1/auth/sso/callback`
2. Authorization URL, token URL, and userinfo URL.
3. Client id and client secret for this V2 client (secret stays on the host).
4. Required scopes.
5. Which claim carries the employee email.
6. Whether a non-production client exists for the first live test.

## Host env to fill later

Copy `.env.example`. Leave secrets out of git.

| Variable | Production intent |
|---|---|
| `SSO_ENABLED` | `false` until the live test below passes |
| `SSO_CALLBACK_CONFIRMED` | `false` until MJU registration is evidenced |
| `SSO_PROVIDER` | `http` on the host, `mock` only in tests |
| `SSO_AUTHORIZATION_URL` | MJU value, currently empty |
| `SSO_TOKEN_URL` | MJU value, currently empty |
| `SSO_USER_INFO_URL` | MJU value, currently empty |
| `SSO_SCOPES` | Only after MJU confirms; the sample value is not confirmed |
| `SSO_CLIENT_ID` | From MJU, not committed |
| `SSO_CLIENT_SECRET` | From MJU, empty in git |
| `SSO_CALLBACK_URL` | The registered callback |
| `SSO_HTTP_TIMEOUT_MS` | `15000` unless MJU asks for another limit |
| `APP_URL` | Public origin used for the success redirect |
| `JWT_SECRET` | Existing V2 secret, independent of SSO |

## Live test (only after the asks above are answered)

1. Keep a second shell ready to set `SSO_ENABLED=false`.
2. On one non-production or agreed client, set the confirmed URLs, `SSO_CALLBACK_CONFIRMED=true`, then `SSO_ENABLED=true`.
3. Open `GET /api/v1/auth/sso/login` and finish the MJU prompt.
4. Do not expect a browser session yet. The redirect is `{APP_URL}/?sso=success` only. A live test of `/auth/me` waits until a reviewed way exists to hand the V2 tokens to the SPA.
5. Repeat the callback URL and expect `SSO_STATE_INVALID`.
6. Try an email that is not in `employees` and an `inactive` row. Expect `SSO_USER_UNKNOWN` and `SSO_USER_DISABLED`.
7. Call `GET /api/v1/auth/sso/me` and `POST /api/v1/auth/sso/logout` with the V2 token.

## Rollback

1. Set `SSO_ENABLED=false` and restart or reload the API process so it sees the env.
2. Set `SSO_CALLBACK_CONFIRMED=false`.
3. Password login on `/api/v1/auth/login` is unchanged.
4. Do not delete `employees` or attendance rows as part of SSO rollback.
