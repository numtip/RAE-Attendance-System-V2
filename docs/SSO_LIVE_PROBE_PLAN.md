# SSO readiness review and live probe plan

Based on code and configuration metadata only (variable names, URL schemes, control flow). No secret, token, client id value or real identity was read, printed or used. **No live SSO call has been made.**

## 1. What the code does today
| Area | Finding (file) |
|---|---|
| Protocol | Plain OAuth 2.0 authorization-code + `userinfo` (`services/sso/oauthProvider.js`); MJU "portal" mode (`SSO_SIGNIN_URL` -> `buildCidUrl`) is the configured live mode and its callback query contract is **not confirmed** (`ssoService.handleCallback` returns 503 `SSO_NOT_READY` in portal mode) |
| OIDC | **None.** No `id_token`, no issuer (`iss`), audience (`aud`), nonce or JWKS validation exists; trust rests on TLS to the configured `token`/`userinfo` URLs and the access token accepted by userinfo |
| Config gate | `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, URLs, client id/secret (`services/sso/ssoConfig.js`, `config/index.js`); OAuth endpoints are empty in `.env.example` |
| State | random 24-byte, 10 min TTL, single-use, **in-memory** (`ssoStateStore.js`); not bound to the user's browser session; lost on restart/multi-instance |
| PKCE | not used |
| Subject mapping | `extractVerifiedSubject` (needs `SSO_SUBJECT_CONTRACT_CONFIRMED=true`) + protected `national_id` -> `employee_uid`; first verified login creates the identity link (`ssoIdentityResolutionService.js`); subject/national conflict -> 409; email mismatch blocks link |
| Session | HS256 JWT (`sub=employee_uid`, no national id), refresh token stored server-side; login handoff = opaque single-use code, 45 s, in-memory (`ssoLoginCodeStore.js`) |
| Logout | revokes the refresh token and returns the MJU `signoutUrl`; the access JWT stays valid until it expires; `SSO_AFTER_SIGNOUT_URL` is configured but unused in code |
| Secrets | client secret only from env; never logged (diagnostics mask claims) |

## 2. Findings and what was done in this branch
| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | `SSO_PROVIDER=mock` (fixed fake identity) had no production guard | High | **Fixed**: production refuses mock (`assertProductionSafeSso`, tests) |
| F2 | Non-https SSO endpoints accepted | High | **Fixed**: production requires https for authorization/token/userinfo/callback/signin/signout (names only in the error) |
| F3 | Fixture/seed `national_id` was stored as plaintext and SSO tests ran without keys | High | **Fixed**: seed rows are converted to HMAC lookups; tests use synthetic keys; SSO resolution passes audit context (`sso:callback`) |
| F4 | No issuer/audience/JWKS/nonce validation | Medium (blocker if MJU issues `id_token`) | **Open**: ask MJU whether an OIDC `id_token` exists; if yes implement `iss`/`aud`/`exp`/signature via JWKS before go-live |
| F5 | State not bound to browser session, no PKCE, in-memory stores | Medium | **Open**: bind state to a signed cookie, add PKCE if MJU supports it, move stores to a shared store before multi-instance |
| F6 | Portal callback query contract and subject claim unconfirmed | Blocker | **Open**: MJU confirmation (`docs/SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md`) |
| F7 | Citizen-ID claim name unconfirmed (`SSO_NATIONAL_ID_CLAIMS`) | Blocker | **Open**: probe with `SSO_USERINFO_PROBE=true` (masked) |
| F8 | Logout does not invalidate the access JWT | Low | Accept for 15 min TTL or add a denylist |
| F9 | `SSO_AFTER_SIGNOUT_URL` unused | Low | Wire or remove |

## 3. Identity rules the probe must respect
* MJU SSO is never required for HIP contractors; no SSO subject is created by onboarding; only a verified MJU callback may create the link (tests: `ssoHipIdentity.test.js`).
* A login that maps to no employee is denied (`SSO_USER_UNKNOWN`), never auto-created; a login of a HIP contractor who has an MJU account links to the same `employee_uid` and does not fabricate `personnel_id`.

## 4. Live SSO probe plan (nothing below is approved or executed)
**Preconditions (all must be true):**
1. MJU confirmations F6/F7 (callback contract, subject, citizen-ID claim) and whether OIDC `id_token` exists (F4).
2. Employee mapping QA passed on the approved scope of 50 unique employees (mapping counts reviewed; HIP id evidence recorded; MJU authoritative source status decided).
3. Migrations 015 and 017 applied to the **target test database** through the separate migration approval; secrets (HMAC key, JWT secret, client secret) provisioned by the secret manager; backend deployed to a non-production host.
4. Production-safety config check passes (https endpoints, `SSO_PROVIDER=http`).

**Steps (single operator, single test account that exists in the approved mapping):**
1. Enable `SSO_USERINFO_PROBE=true` only: login once; read the masked manifest (claim names, citizen-ID claim present/format, subject claim present). No session is issued in this mode.
2. Record claim names, subject stability across two logins, issuer/audience if any `id_token` is present.
3. Disable probe, enable the real chain for the test account only: first login must create exactly one approved link; second login must resolve by subject; wrong/old account must return `SSO_USER_UNKNOWN`.
4. Negative checks: expired/reused `state` (403), replayed handoff code, logout then refresh-token reuse (401).
5. Capture evidence as counts/status codes only (no tokens, no citizen ID); disable SSO again.

**Approvals required before step 1:** (a) MJU contract confirmation, (b) migration approval for the test DB, (c) secret provisioning approval, (d) deploy-to-test approval, (e) named test account owner consent, (f) SSH/VPS access gate if the host is remote. Each is a separate human decision; none is implied by this document.

## 5. Not done
No push/merge, no SSH, no migration, no import, no deploy, no live SSO or browser E2E.
