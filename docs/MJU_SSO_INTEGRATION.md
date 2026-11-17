# MJU SSO Integration — RAE Attendance System V2

## 1. Architecture & Shared Adapter Reuse

RAE Attendance System V2 (`SSO_PROVIDER=portal`) integrates MJU SSO by reusing the shared,
framework-independent `@mju/sso-integration` (`v1.0.0-rc.6`) adapter standard from
`numtip/mju-sso-integration@cb8815c` (`backend/src/vendor/mju-sso-integration/`, bridged by
`backend/src/services/sso/mjuPortalAdapterBridge.js`).

### End-to-End Flow

1. **Login (`GET /api/v1/auth/sso/login`)**
   - Validates fail-closed gates (`SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_ALLOW_UNVERIFIED_CONTRACT`,
     and in `production` a valid `SSO_OWNER_RISK_ACCEPTANCE` record).
   - Rejects the MJU sample client ID (`SSO_CLIENT_ID_IS_SAMPLE`) and untrusted/non-HTTPS endpoints.
   - Registers a single-use browser attempt binding (SHA-256 digest stored in MariaDB
     `sso_login_attempt` via migration `028_sso_login_attempt.sql`), sets an `HttpOnly; SameSite=Lax`
     cookie (`rae_sso_bind`), and redirects (`302`) to `https://sso.mju.ac.th/signin.aspx?cid=<clientId>`.
2. **Callback (`GET /api/v1/auth/sso/callback?ac=<32 alphanumeric>`)**
   - Enforces `GET` only (`405` `Allow: GET` otherwise), burns `rae_sso_bind` on first presentation,
     rejects duplicate `ac` parameters (`400 SSO_CALLBACK_DUPLICATE`), validates `AC_PATTERN`
     (`^[A-Za-z0-9]{32}$`), and atomically claims the `ac` digest against replay (`403 SSO_CODE_REPLAY`).
   - Exchanges `ac` server-to-server (`POST https://sso.mju.ac.th/token.aspx` JSON `{ clientID, code }`,
     `redirect: 'error'`, 15 s timeout, 64 KiB cap, strict `2xx` JSON object).
   - Validates `citizenID` under contract items `C-08` (`VERIFIED`, 2026-11-04 MJU SSO administrator
     confirmation) and `C-14` (`VERIFIED`, 2026-11-06 PDPA lawful basis, gated at runtime by
     `SSO_LAWFUL_BASIS_APPROVED=true`), immediately deriving the 64-hex application-scoped HMAC
     `subjectKey` (`deriveSubjectKey` with `SSO_APP_ID` + `SSO_HMAC_KEY` >= 32 bytes). Raw `citizenID`
     never leaves the adapter.
3. **Approved Identity Mapping & Existing RBAC**
   - `identityResolutionService.resolve('mju_sso', subjectKey)` requires an active provider, an
     **approved** row in `employee_identity_links` carrying attributable approval provenance
     (`approved_by`, `approved_at`), an `active` unlocked employee in `employees`, and matching
     `email_snapshot` (when recorded).
   - **No auto-linking, no auto-approval, and no e-mail fallback.** Unlinked, `candidate`, `rejected`,
     or `revoked` links fail closed (`403`).
   - Application RBAC roles (`EMPLOYEE`, `MANAGER`, `EXECUTIVE`, `ADMIN`) and data-scope grants
     (`authorization_grants`, `employee_org_membership`) remain 100% owned by Attendance V2
     (`authorizationService.js`).
4. **Session Handoff (`POST /api/v1/auth/sso/exchange`)**
   - Callback mints rotated HS256 access + refresh tokens server-side, sets a 45-second `HttpOnly`
     handoff binding cookie (`rae_sso_handoff`), and redirects (`302`) to
     `${APP_URL}/auth/sso/complete?sso=success&code=<one-shot>`.
   - `frontend/src/views/SsoCompleteView.vue` exchanges the one-shot `code` for
     `{ accessToken, refreshToken, employee }` without any JWT, refresh token, `ac`, or PII ever
     appearing in a URL.
5. **Logout (`POST /api/v1/auth/sso/logout` & `GET /api/v1/auth/sso/signout`)**
   - Revokes both the presented access token (`jti` in `revoked_access_tokens`) and refresh token
     (`refresh_tokens`) server-side **before** returning the validated
     `https://sso.mju.ac.th/signout.aspx?cid=<clientId>` URL.

---

## 2. Staging Configuration & Preflight

All gates ship **OFF** (`false`) by default. Configure secrets outside Git on the staging host only:

```text
NODE_ENV=staging
DATA_SOURCE=mariadb
APP_URL=https://<staging-host>
SSO_ENABLED=true
SSO_CALLBACK_CONFIRMED=true
SSO_PROVIDER=portal
SSO_CLIENT_ID=<registered 32-hex client id for staging>
SSO_SIGNIN_URL=https://sso.mju.ac.th/signin.aspx
SSO_SIGNOUT_URL=https://sso.mju.ac.th/signout.aspx
SSO_TOKEN_URL=https://sso.mju.ac.th/token.aspx
SSO_AFTER_SIGNOUT_URL=https://<staging-host>/login
SSO_ALLOWED_HOSTS=sso.mju.ac.th
SSO_REQUIRE_HTTPS=true
SSO_ALLOW_UNVERIFIED_CONTRACT=true
SSO_SUBJECT_CLAIM=citizenID
SSO_APP_ID=rae-attendance-v2
SSO_HMAC_KEY=<per-application CSPRNG secret, >= 32 bytes; never commit>
SSO_LAWFUL_BASIS_APPROVED=true
SSO_LOGIN_ATTEMPT_STORE=mariadb
```

Run the read-only preflight check before enabling traffic (prints booleans/blockers only, never secrets):

```bash
npm run sso:preflight
```

For `NODE_ENV=production`, `SSO_ALLOW_UNVERIFIED_CONTRACT=true` is refused unless
`SSO_OWNER_RISK_ACCEPTANCE` points to a signed owner risk-acceptance JSON file covering all
unverified contract items (`C-01`..`C-07`, `C-09`..`C-13`) with `providerCertified: false`, and
owner deployment approval is recorded.

---

## 3. Onboarding an Approved Identity Link (No Auto-Approval)

1. Derive the employee's 64-hex `subjectKey` offline on the host (never commit raw `citizenID` or key):
   ```bash
   node -e "const { deriveRaeSsoSubjectKey } = require('./backend/src/services/sso/mjuPortalAdapterBridge'); deriveRaeSsoSubjectKey({ citizenId: process.env.TARGET_CITIZEN_ID, hmacKey: process.env.SSO_HMAC_KEY, appId: process.env.SSO_APP_ID || 'rae-attendance-v2' }).then(console.log);"
   ```
2. Create a `candidate` link in `employee_identity_links` (`provider_key = 'mju_sso'`,
   `provider_subject = <64-hex subjectKey>`, `subject_type = 'hmac_citizen_id'`,
   `source = 'operator_review'`) for the verified `employee_uid`, then approve it with an
   attributable human reviewer (`approved_by`, `approved_at`).

---

## 4. Rollback

Set `SSO_ENABLED=false` and restart/reload the backend service. All `/api/v1/auth/sso/*` routes
immediately return `403 SSO_DISABLED` without affecting local `/api/v1/auth/login` sessions,
employee records, or HIP/FaceScan attendance data.
