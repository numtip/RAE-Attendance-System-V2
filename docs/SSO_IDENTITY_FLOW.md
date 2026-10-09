# MJU SSO identity flow (locked model)

Canonical authenticated identity: **`employees.employee_uid`**.

```text
MJU SSO userinfo
  → citizen ID claim (national_id resolution)
  → employee_identifier (id_type = national_id)
  → employee_uid
  → JWT (sub = employee_uid) + refresh token

MJU SSO opaque subject (sub / subject / providerSubject)
  → employee_identity_links.provider_subject
  → employee_uid (after link exists)
```

Name fields are never used for matching.

---

## Claim contract

| Item | Status | Notes |
|------|--------|--------|
| Provider subject | **CONFIRMED in code** | OAuth profile: `sub`, `subject`, or `providerSubject` when `SSO_SUBJECT_CONTRACT_CONFIRMED=true` (`mjuSubjectAdapter.js`) |
| Citizen / national ID | **NEEDS_CONFIRMATION on live MJU SSO** | Default claim names from repo docs only: `citizenID` (Person API / `IDENTITY_CONTRACT.md`), `citizen_id` (`DATA_MAPPING.md`). Override with env `SSO_NATIONAL_ID_CLAIMS` (comma-separated) after MJU confirms. |
| Email | Optional directory | Stored on employee row and JWT for compatibility; **not** the primary SSO identity key |
| Personnel ID | Not used for SSO login | May appear in link snapshots from enrich |
| Callback query `ac` | **Rejected** | Must not be used as identity |
| Portal-only callback | **UNKNOWN** | Portal mode without OAuth stays `503 SSO_NOT_READY` until MJU confirms exchange |

Mock / CI userinfo fixture (`oauthProvider.js`): `citizenID`, `sub`, `email` (fake 13-digit citizen ID only).

---

## Returning login

1. OAuth callback with valid `code` + `state`.
2. Fetch userinfo.
3. If provider subject is verified and an **approved** `employee_identity_links` row exists → load employee by `employee_uid`.
4. Else require citizen ID claim → `employeeIdentityService.resolve('national_id', …)` → `employee_uid`.
5. Active / unlocked checks → issue JWT + refresh token.

---

## First login (subject linking)

When citizen ID resolves confidently and provider subject is verified:

1. If subject already linked to the same `employee_uid` → use link.
2. If subject linked to another employee → `409 IDENTITY_SUBJECT_CONFLICT`.
3. If no link → insert **approved** link (`source = sso_national_id_resolution`, `approved_by = system:sso`).
4. Audit via `authLogs` when configured (no raw citizen ID or subject in messages).

Manual candidate → approve flow (`identityResolutionService`) remains for operator review paths.

---

## Session / JWT

Access token payload:

- `sub` → `employee_uid`
- `role`, `email`, `authMethod: sso`

Not included: `national_id`, raw provider claims, citizen ID.

RBAC and data scope: `authenticate` → `req.auth.employeeUid` → `authorizationService` (unchanged).

---

## Privacy

- Do not log raw citizen ID or national_id values.
- National ID extraction logs use masked form only (`maskIdentifierForLog`).
- API `/auth/sso/me` returns employee directory fields, not national_id.

---

## Error cases (user-facing)

| Code | Meaning |
|------|---------|
| `SSO_NATIONAL_ID_MISSING` | Userinfo lacked a configured citizen ID claim |
| `SSO_NATIONAL_ID_INVALID` | Claim present but not 13-digit Thai ID |
| `SSO_USER_UNKNOWN` | No `employee_identifier` row for citizen ID |
| `IDENTITY_SUBJECT_CONFLICT` | Provider subject belongs to another employee |
| `IDENTITY_NOT_APPROVED` | Link exists but not approved |
| `SSO_USER_DISABLED` | Employee inactive |
| `ACCOUNT_LOCKED` | Employee locked |
| `SSO_NOT_READY` | Portal/diagnostic gates, config incomplete |

---

## Environment

| Variable | Purpose |
|----------|---------|
| `SSO_ENABLED` | Master gate |
| `SSO_CALLBACK_CONFIRMED` | Callback registration acknowledged |
| `SSO_SUBJECT_CONTRACT_CONFIRMED` | Allow opaque `sub` as provider subject |
| `SSO_NATIONAL_ID_CLAIMS` | Optional override for citizen ID claim names |
| OAuth URLs + secret | Required for mock/http provider callback path |

---

## Browser session handoff (Pass 9)

```text
GET /api/v1/auth/sso/callback
  → resolve employee_uid + issue V2 tokens (server-side)
  → issue single-use opaque login code (45s default TTL)
  → 302 APP_URL/auth/sso/complete?code=<opaque>

POST /api/v1/auth/sso/exchange { code }
  → validate + consume code
  → { accessToken, refreshToken, employee } (same shape as password login)
```

Codes never contain JWT, citizen ID, or employee payloads. JWT must not appear in query strings.

---

## Live MJU userinfo contract probe

Set `SSO_USERINFO_PROBE=true` with OAuth URLs configured and `SSO_ENABLED=true`.

Callback completes token + userinfo fetch, then returns **`503 SSO_NOT_READY`** with redacted `details.userinfo`:

- field **name**, **type**, **presence**, **length**
- national-id-shaped fields include **maskedSample** only (last 4 digits pattern)
- no access token, refresh token, or raw citizen ID in logs or response body

Operator sets `SSO_NATIONAL_ID_CLAIMS` after confirming the real claim name from probe output.

Provider subject linking remains gated on `SSO_SUBJECT_CONTRACT_CONFIRMED=true`.

**Status:** live MJU userinfo claim name is **NEEDS_CONFIRMATION** until an operator runs probe against real MJU (human action: enable probe env, complete one SSO login, read redacted probe JSON, set claims env, disable probe).

---

## OAuth state store (Pass 9)

`ssoStateStore.js` keeps pending OAuth `state` in **process memory** (10 minute TTL, single consume).

- **QA / single-instance:** acceptable.
- **PRE-PROD blocker:** multi-instance or rolling deploy requires a shared state store (Redis or DB) before production SSO.

---

## citizen_id_hash (Pass 9 evaluation)

Deferred to **Pass 10**. Planned algorithm when implemented: `HMAC-SHA256(pepper, normalized_national_id)` — never plain SHA-256; hash is audit artifact only, not a login key.

---

## Unresolved

- Live MJU SSO userinfo field name for citizen ID (**NEEDS_CONFIRMATION** until probe run).
- Portal callback ticket exchange (`ac`) and token/userinfo URLs.
- Distributed OAuth `state` for multi-instance.

See also: `docs/IDENTITY_CONTRACT.md`, `docs/SSO_CONTRACT_CONFIRMATION.md`, `docs/SSO_ACTIVATION_RUNBOOK.md`.

## Update: protocol gates and state binding
The OAuth path is OFF until `SSO_PROTOCOL_CONTRACT_CONFIRMED=true` and, for a live provider, `SSO_NATIONAL_ID_CLAIMS` names the confirmed citizen-ID claim. `/auth/sso/login` sets an HttpOnly SameSite=Lax binding cookie and the callback rejects (and burns) any `state` presented without it. Evidence and MJU questions: `docs/SSO_PROTOCOL_EVIDENCE.md`; review and merge order: `docs/PR_REVIEW_SSO_INTEGRATION.md`.
