# MJU SSO subject contract — integration checklist

**Purpose:** Facts still required from MJU before V2 may wire `GET /api/v1/auth/sso/callback` to `extractVerifiedSubject()` and `ssoIdentityChainService`.

**Policy:** `SSO_ENABLED=false` and `SSO_SUBJECT_CONTRACT_CONFIRMED=false` remain the defaults. No VPS changes. No production database writes. **`mju-person-enrich` is local-only and must never run on the callback path.**

## Target chain (prepared on `main`, HTTP not connected)

```text
MJU callback
  → extractVerifiedSubject()
  → IdentityResolutionService.resolve()
  → approved identity link
  → active employee
  → RBAC / data scope (per API request)
  → session (JWT + refresh)
```

## Facts required from MJU

| # | Fact | Status | Notes |
|---|---|---|---|
| 1 | Authoritative **subject field name** in callback, token response, or userinfo | **UNKNOWN** | V2 must not guess `sub`, `email`, or `ac`. |
| 2 | Subject is **stable/immutable** for the life of the account | **UNKNOWN** | Required before storing `employee_identity_links.provider_subject`. |
| 3 | Where the subject appears **after** callback query `ac` | **UNKNOWN** | Callback shape: `GET` with single field `ac` (32 chars) is **CONFIRMED**; meaning of `ac` is **UNKNOWN**. |
| 4 | How **`ac` is validated or resolved** (server-side exchange, redirect, ticket) | **UNKNOWN** | **`ac` must not be used as identity.** |
| 5 | **Token / ticket exchange** endpoint (if any) | **UNKNOWN** | Do not call guessed URLs. |
| 6 | **Userinfo** endpoint (if any) | **UNKNOWN** | Do not call guessed URLs. |
| 7 | **Client secret** required for exchange | **NO EVIDENCE** | Keep `SSO_CLIENT_SECRET` empty until MJU confirms. |
| 8 | **Signature / hash** verification on callback or token payload | **UNKNOWN** | Fail closed; do not invent verification. |
| 9 | **Subject vs email** relationship (same person, different fields, optional email) | **UNKNOWN** | Email may be audit evidence only; not the permanent SSO key. |

## Already CONFIRMED (registration / public pages)

| Item | Status |
|---|---|
| V2 callback URL registered with MJU | **CONFIRMED** |
| Sign-in / sign-out portal URLs with `cid` | **CONFIRMED** |
| Callback HTTP method and `ac` query **shape** (not semantics) | **CONFIRMED** shape / **UNKNOWN** meaning |

See `docs/SSO_CONTRACT_CONFIRMATION.md` for the full matrix.

## Fail-closed rules (locked)

| Input / state | Result |
|---|---|
| `SSO_ENABLED=false` | No SSO login/callback session |
| `SSO_SUBJECT_CONTRACT_CONFIRMED=false` | `extractVerifiedSubject` → `unknown`; no chain session |
| Callback `ac` as identity | `invalid`; no session |
| Email-only as permanent subject | `invalid`; no session |
| Person API / `mju-person-enrich` at runtime | **Forbidden** — not implemented on callback path |
| Identity link `candidate` / `rejected` / `revoked` | Denied at `resolve()` |
| Unknown provider subject | Denied at `resolve()` |
| Inactive / locked employee | Denied after link resolve |

## Operator gate before wiring HTTP callback

1. [ ] MJU provides written answers for rows 1–9 above.
2. [ ] Update `extractVerifiedSubject` implementation to match the contract (no `ac` mapping).
3. [ ] Set `SSO_SUBJECT_CONTRACT_CONFIRMED=true` only after row 1–2.
4. [ ] Wire `ssoService.handleCallback` to the prepared chain (separate change; still behind `SSO_ENABLED`).
5. [ ] Non-production MJU test, then `SSO_ACTIVATION_RUNBOOK.md`.

## Tests (CI)

- [x] `backend/tests/mjuSubjectAdapter.test.js`
- [x] `backend/tests/ssoIdentityChain.test.js`
- [x] `backend/tests/identityLink.test.js`
- [x] `backend/tests/ssoCallbackWiring.test.js`
