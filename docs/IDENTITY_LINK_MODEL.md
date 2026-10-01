# Identity link model (V2)

**Status:** Schema, repository, and approval service prepared. **SSO runtime stays disabled** until the MJU SSO subject contract is confirmed in writing.

## Purpose

V2 must authenticate MJU users by a **confirmed opaque MJU SSO subject**, not by email alone, callback `ac`, or Person API enrichment output.

| Input | Role |
|---|---|
| **MJU SSO subject** (future) | Authoritative authentication identity after contract confirmation |
| **`mju-person-enrich`** (local only) | Candidate enrichment and review evidence only |
| **`employees.email`** | Directory contact field; may appear in snapshots for audit, not the permanent SSO key |

## Tables

Migration `012_identity_links.sql` adds:

### `identity_providers`

| Column | Notes |
|---|---|
| `provider_key` | e.g. `mju_sso` |
| `name` | Display label |
| `status` | `active` or `disabled` |

### `employee_identity_links`

| Column | Notes |
|---|---|
| `employee_uid` | FK to `employees` |
| `provider_id` | FK to `identity_providers` |
| `provider_subject` | Confirmed MJU subject; never `ac` |
| `subject_type` | e.g. `opaque` |
| `email_snapshot` | Optional review evidence |
| `personnel_id_snapshot` | Optional review evidence |
| `citizen_id_hash` | Optional; never raw national ID by default |
| `status` | `candidate`, `approved`, `rejected`, `revoked` |
| `confidence` | Operator or enrichment confidence |
| `source` | e.g. `operator_review`, `mju_person_enrich` |
| `approved_by`, `approved_at` | Human approval accountability |

**Constraints and indexes**

- Unique `(provider_id, provider_subject)`
- Indexes for provider-subject lookup, employee lookup, and status filtering
- Application enforces at most one **approved** link per `(employee_uid, provider_id)`

**Never stored:** raw tokens, session payloads, Person API responses, callback `ac`, or bearer secrets.

## Lifecycle

```text
candidate → human review → approved → (active sign-in when employee is active)
candidate → rejected
approved → revoked
```

| Status | Sign-in |
|---|---|
| `candidate` | Denied |
| `rejected` | Denied |
| `revoked` | Denied |
| `approved` | Allowed only if employee is `active`, account not locked, and email snapshot (if present) matches employee email |

Ambiguous, `not_found`, timeout, or fallback enrichment outcomes **must not** auto-approve. See `docs/SSO_PERSON_ENRICHMENT_INTEGRATION.md`.

## Authentication chain (future runtime)

```text
MJU SSO subject
  → approved identity link
  → active employee
  → RBAC / data scope (authorization grants)
  → V2 session
```

Any missing or invalid step **fail closed** (no session).

## Code

| Piece | Location |
|---|---|
| Domain constants | `backend/src/domain/identityLink.js` |
| Repository (fixture + MariaDB) | `backend/src/repositories/fixtureIdentityLinkRepository.js`, `backend/src/repositories/mariadb/identityLinkMariaDbRepository.js` |
| Resolution / approval service | `backend/src/services/identityResolutionService.js` |
| Tests | `backend/tests/identityLink.test.js` |

The SSO callback is **not** wired to this service yet. Current `ssoService` still uses email matching only when SSO is enabled in non-diagnostic mock mode.

## Operator workflow

1. Run **local-only** `mju-person-enrich` to prepare evidence (single-match only).
2. Create a **candidate** link in V2 (future admin API) with provider subject from the **MJU contract**, not from `ac`.
3. Second reviewer **approves** or **rejects**.
4. After live contract test, enable SSO resolution through `IdentityResolutionService.resolve()`.
