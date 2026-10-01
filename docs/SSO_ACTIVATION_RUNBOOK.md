# SSO activation runbook

**Do not set `SSO_ENABLED=true` from this document.** Live MJU calls stay blocked until the external checklist is confirmed. CI uses the mock provider only.

Related: `docs/SSO_ACTIVATION_CHECKLIST.md`, `docs/SSO_READINESS.md`, `docs/SSO_REUSE_PLAN.md`.

## What is known

| Item | Value | Evidence |
|---|---|---|
| V2 routes | `GET /api/v1/auth/sso/login`, `GET /api/v1/auth/sso/callback`, `GET /api/v1/auth/sso/me`, `POST /api/v1/auth/sso/logout` | `docs/SSO_READINESS.md` |
| Proposed production callback | `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` | Proposed in `docs/SSO_ACTIVATION_CHECKLIST.md`. **Not confirmed registered.** |
| Donor routes | `/api/auth/sso/login`, `/callback`, `/me`, `POST /logout` | `docs/SSO_REUSE_PLAN.md` |
| Donor env names read by legacy code | `SSO_ENABLED`, `SSO_ENDPOINT`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_CALLBACK_URL` | Same doc. Values are not in git. |
| Host env names not read by donor code | `SSO_AUTHORIZATION_URL`, `SSO_TOKEN_URL`, `SSO_USER_INFO_URL`, `SSO_REDIRECT_URI` | Names only. Values are not in git. |
| Match key in V2 code | Email from `email`, else `mail`, else `preferred_username`, compared to `employees.email` | `ssoService.js`. Fail closed. |
| Disabled account | `status` other than `active` returns `403` `SSO_USER_DISABLED` | This prep change |
| Locked account | `lockedUntil` in the future returns `403` `ACCOUNT_LOCKED` | Same path as password login |

## UNKNOWN (do not guess)

| Item | Why it stays unknown |
|---|---|
| Authorization URL | Donor `SSO_ENDPOINT` and host `SSO_AUTHORIZATION_URL` were not proven to be the same URL. No URL value is in the repo. |
| Token URL | Host had the env name. The value is not in the repo. |
| Userinfo URL | Host had the env name. The value is not in the repo. |
| Scopes | V2 default `openid profile email` is documented as an assumption in `SSO_READINESS.md`. |
| Client ID | Name exists. Value must come from MJU and must not be committed. |
| Required claims | Code accepts `email`, `mail`, or `preferred_username`. MJU has not confirmed which claim it sends. |
| Registered legacy callback | `SSO_CALLBACK_URL` / `SSO_REDIRECT_URI` values were not recorded. Do not assume they equal the V2 path. |
| Post-login browser path | The controller redirects to `{APP_URL}/?sso=success`. It does not read a return URL from the query string. Whether that path is the SPA entry is an operator decision and is **not** hard-coded here. |

## Security behavior already in code

| Control | Behavior |
|---|---|
| State / CSRF | Random 24-byte hex `state`, 10 minute TTL, single `consume` (`ssoStateStore.js`). Missing, expired, or reused state is `403` `SSO_STATE_INVALID`. |
| Callback validation | `code` required. IdP `error` is `401` `SSO_DENIED`. State is checked before any token request. |
| Redirect allowlist | Login redirects only to the configured authorization URL plus OAuth query params. Success redirects only to `APP_URL`. There is no caller-supplied redirect. |
| Token handling | Provider access token is used once for userinfo and is not stored as the V2 session. V2 issues its own JWT and refresh token. Legacy tokens are not imported. |
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
4. Expect a redirect to `{APP_URL}/?sso=success` and a V2 session for an **active** employee whose email matches the claim.
5. Repeat the callback URL and expect `SSO_STATE_INVALID`.
6. Try an email that is not in `employees` and an `inactive` row. Expect `SSO_USER_UNKNOWN` and `SSO_USER_DISABLED`.
7. Call `GET /api/v1/auth/sso/me` and `POST /api/v1/auth/sso/logout` with the V2 token.

## Rollback

1. Set `SSO_ENABLED=false` and restart or reload the API process so it sees the env.
2. Set `SSO_CALLBACK_CONFIRMED=false`.
3. Password login on `/api/v1/auth/login` is unchanged.
4. Do not delete `employees` or attendance rows as part of SSO rollback.
