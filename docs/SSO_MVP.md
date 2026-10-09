# SIMPLE SSO (MVP)

Goal: a person with an MJU Login signs in through MJU SSO and lands in Attendance as the right employee. Nothing more. We do not invent an authentication protocol: the backend only speaks what MJU documents, and stays closed (no redirect, no session) until that is written down (`docs/SSO_PROTOCOL_EVIDENCE.md`).

## Flow

```
Browser                    Attendance backend                          MJU SSO
  | GET /api/v1/auth/sso/login |                                         |
  |--------------------------->| set HttpOnly+SameSite=Lax binding cookie |
  |<---------------------------| 302 -> MJU (state bound to that cookie)  |
  |------------------------------------------------------------------>   | user signs in at MJU
  | GET /auth/sso/callback?code&state (+cookie)                           |
  |--------------------------->| 1 validate: cookie+state match, single use, not expired
  |                            | 2 redeem code with MJU (token -> userinfo)  ---->
  |                            | 3 map identity (below)
  |                            | 4 create our own session (JWT + refresh token)
  |<---------------------------| 302 /auth/sso/complete?code=<one-time handoff>
  | POST /auth/sso/exchange    |  -> { accessToken, refreshToken }
  | POST /auth/sso/logout      |  -> refresh token revoked (+ MJU sign-out URL)
```

Identity mapping (never by name or e-mail alone):
1. A previously linked, **verified SSO subject** -> its `employee_uid`.
2. First login: the citizen ID claim is looked up through the HMAC contract (no raw National ID stored or logged) -> `employee_uid`; the verified subject is then linked to that employee.
3. Anything else (unknown ID, name/e-mail only, subject already linked to someone else) -> denied; no employee, identifier or link is ever created by a login.

Contractors without an MJU account use their **HIP/FaceScan ID for Attendance**; SSO is not required and no SSO account or `personnel_id` is fabricated. If a contractor does have an MJU account, the verified login links to the same `employee_uid`.

## Standard mechanisms used (no custom crypto)
Express `res.cookie` (`HttpOnly`, `SameSite=Lax`, `Secure` in production), single-use random `state`, `jsonwebtoken` HS256 sessions (algorithm pinned, unique `jti`), single-use refresh tokens, HMAC lookups from PR #30. No new dependency.

## Minimum configuration (all default OFF)
`SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_CLIENT_ID`, `SSO_CALLBACK_URL`, the three MJU endpoints, `SSO_CLIENT_SECRET` (only if MJU requires one), `SSO_PROTOCOL_CONTRACT_CONFIRMED`, `SSO_NATIONAL_ID_CLAIMS`, `JWT_SECRET`, `EMPLOYEE_IDENTIFIER_HMAC_KEY`. Check with `npm run sso:preflight` (prints yes/no only).

## Deliberately out of the MVP
PKCE, OIDC `id_token` validation, custom multi-instance state/session stores (single instance; states and handoff codes are in memory), advanced audit trail, key-rotation automation, SSO-driven provisioning, access-token revocation lists, rate limiting inside the app (do it at the reverse proxy). Adding them later does not change this flow.

## Tests (`backend/tests/ssoMvp.test.js`, synthetic identities, real Express app)
valid login -> /me -> logout; contractor without MJU (HIP only, no SSO needed); contractor with MJU account (same `employee_uid`); spoofed/forged/other-browser callback; invalid token cases and forged/tampered session tokens; wrong-user mapping; state and handoff replay and expiry; fail-closed defaults; production cookie `Secure`.

## Start testing with the real MJU login (shortest path)
1. **MJU IT, one message** (questions 1-7 of `docs/SSO_PROTOCOL_EVIDENCE.md`): what the callback contains, how to redeem it (endpoints, secret), the subject claim, the citizen-ID claim name; and either register `http://127.0.0.1:3210/api/v1/auth/sso/callback` for the client (local test, no deploy) or tell us which test host to use.
2. **Discovery login (no session issued):** local backend with `SSO_ENABLED=true`, `SSO_CALLBACK_DIAGNOSTIC=true`, real `SSO_CLIENT_ID`/signin URL; sign in once with your own MJU account; read the logged field names/lengths. Then `SSO_USERINFO_PROBE=true` once endpoints are known to see the masked claim manifest.
3. **Real session test:** disposable local MariaDB (migrations incl. 015 and 017), one synthetic employee whose HMAC national ID equals the tester's, `EMPLOYEE_IDENTIFIER_HMAC_KEY`/`JWT_SECRET` from your own shell, the three confirm flags set from MJU's answers; `npm run sso:preflight` must pass; sign in once, check `/auth/sso/me`, logout.
Alternative to step 1 if MJU is slow: with approval, read-only inspection of an existing MJU SSO client (`raemju-project/metabase-sso-deploy` on the VPS) to learn the contract. Needs the SSH gate; nothing is changed there.
