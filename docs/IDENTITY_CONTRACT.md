# Identity contract — RAE Attendance V2 ↔ MJU Person Enrich

**Status:** Design + **identity foundation implemented** (see `docs/IDENTITY_IMPLEMENTATION.md`). SSO callback, FaceScan ingestion, and Person API runtime remain out of scope.

**Audience:** Engineers wiring SSO, FaceScan, HR onboarding, and optional local enrichment.

---

## 1. Canonical identity definition

| Concept | V2 implementation today | Contract role |
|--------|-------------------------|---------------|
| **Canonical employee identity** | `employees.employee_uid` (`VARCHAR(36)`, PK) | Single internal person key for attendance, leave, auth sessions, and org scope |
| **Business employee code** | `employees.employee_id` (unique, not nullable) | Human/HR code; may appear in imports and FaceScan payloads as `employee_id`; **not** a substitute for `employee_uid` in new APIs |
| **Directory contact** | `employees.email` (unique) | Login aid and directory field; **not** the permanent SSO key once subject contract is live |
| **Display / org attributes** | `first_name_*`, `last_name_*`, `department`, `position`, etc. | **Never** used as primary matching keys for attendance or auth |

There is **no** separate `person` table in V2. All attendance facts reference `employee_uid` (see `daily_attendance`, `monthly_summary`).

**Preferred mental model:**

```text
canonical_employee_id  := employees.employee_uid
    ├── employee_identifier[]     (operational / source-system external IDs)
    └── employee_identity_links[] (SSO provider subjects — separate table by design)
```

---

## 2. Identifier types

### 2.1 `employee_identifier` (operational external IDs)

**Table:** `employee_identifier` (`database/migrations/003_employee_identifier.sql`)

| `id_type` (migration `013`) | Meaning | Role |
|-----------------------------|---------|------|
| `national_id` | Thai Citizen ID | **MJU SSO / identity resolution only** — stored for deterministic `national_id` → `employee_uid`; **not** an attendance identifier |
| `facescan_id` | HIP / FaceScan USERID | **Attendance-source identity** → `employee_uid` at ingestion boundary |
| `employee_id` | Business staff code | Personnel identifier; may duplicate `employees.employee_id` |
| `personnel_id` | MJU personnel code | Additional personnel identifier |

**Implemented (migration `013`):** ENUM above; FK + UNIQUE (`id_type`, `id_value`); `source_system`, `status`, `verified_at`. **`sso_subject` is not stored here** — use `employee_identity_links` (§2.2).

**Locked flows:**

```text
MJU SSO citizen_id (national_id) → employee_identifier → employee_uid
HIP facescan_id → employee_identifier → employee_uid
Attendance / Leave / Reports → employee_uid only
```

**Service:** `employeeIdentityService` resolves `national_id`, `facescan_id`, `employee_id`, `personnel_id` to `employee_uid`. Citizen ID is never exposed raw in list/API/log output (masked only).

### 2.2 `employee_identity_links` (SSO provider identity)

**Table:** `employee_identity_links` (`012_identity_links.sql`) — see `docs/IDENTITY_LINK_MODEL.md`.

| Field | Role |
|-------|------|
| `provider_subject` | Confirmed opaque MJU SSO subject — **authoritative for SSO** after approval |
| `personnel_id_snapshot` | Review evidence only (from HR or enrich); not a login key |
| `citizen_id_hash` | Optional controlled match artifact; **never** raw citizen ID |
| `email_snapshot` | Audit / consistency check vs `employees.email` |

**Identifier type equivalent:** `sso_subject` is represented as `(provider_key, provider_subject)` on this table, **not** as a row in `employee_identifier`.

### 2.3 MJU Person API fields (enrichment only)

From local `mju-person-enrich` (not V2 runtime):

| Field | Classification | V2 use |
|-------|----------------|--------|
| `citizenID` | **SENSITIVE** | Maps to V2 `national_id` in `employee_identifier` for SSO resolution only; never UI/logs/API lists |
| `e_mail` / `email` | **SENSITIVE** / directory | Snapshot or `employees.email` consistency only |
| `firstName`, `lastName` | **LOOKUP_ONLY** / **DISPLAY_ONLY** | Enrich scripts only; **no** V2 name-based join for attendance |
| `personnelType`, `faculty`, `position`, `positionCode` | **DISPLAY_ONLY** / **EXTERNAL_ID** (`positionCode`) | HR display; not matching keys |
| `personnelID`, `personTypeName` (spec) | **Not observed in cache** | Do not depend until API confirms |

---

## 3. Source-of-truth matrix

| Data | System of record | Consumers | Must not |
|------|------------------|-----------|----------|
| Who works here (master row) | V2 `employees` (HR/onboarding import) | Auth, attendance, leave, RBAC | Be replaced by Person API or FaceScan |
| Attendance events | V2 `daily_attendance` (future: staging → uid) | Reports, compute service | Join on person name |
| FaceScan raw events | Legacy/staging (documented in `CURRENT_DATABASE_SCHEMA.md`; not in V2 migrations) | Ingestion (future) | Define canonical identity |
| MJU SSO citizen / resolution | `employee_identifier.national_id` → `employee_uid` | SSO chain (future) + identity service | Use as attendance key or expose raw in UI/logs |
| MJU SSO opaque subject | MJU IdP + **approved** `employee_identity_links` | Session issuance | Resolve from `ac`, email alone, or enrich CSV |
| MJU Person directory | MJU Person API via **local** `mju-person-enrich` | Operator review → candidate link | Run inside V2 backend/CI; commit tokens/PII |
| External device/user id | `employee_identifier.facescan_id` | FaceScan → `employee_uid` | Treat as canonical id |
| Business staff code | `employees.employee_id` | Imports, some compute payloads | SSO session key |

---

## 4. Mapping flow

### 4.1 HR / onboarding → canonical employee

```text
HR file / synthetic onboarding JSON
  → validate (scripts/data-onboarding/lib.mjs)
  → employees row (employee_uid, employee_id, email, …)
  → optional employee_identifier (facescan_id, employee_id; NOT national_id in import)
  → employee_org_membership + authorization_grants
```

Natural keys in files: `employee_id`, email. Importer resolves to `employee_uid` before attendance rows.

### 4.2 FaceScan → attendance (future implementation)

```text
FaceScan payload (facescan_id / USERID, scan time, …)
  → resolve employee_uid via employee_identifier WHERE id_type = 'facescan_id'
  → if unresolved: staging quarantine (no name-only auto-match)
  → daily_attendance.employee_uid
```

**Rule:** FaceScan USERID maps to `employee_identifier.id_value` with `id_type = 'facescan_id'`. Attendance compute today accepts `employee_id` string in API body (`attendanceComputeService`) — contract target is uid resolution at ingestion boundary.

### 4.3 MJU SSO → session (target runtime)

```text
MJU OAuth callback
  → extractVerifiedSubject() (mjuSubjectAdapter)
  → IdentityResolutionService.resolve(provider, provider_subject)
  → approved employee_identity_links row
  → active employees row
  → JWT (sub = employee_uid)
```

**Today:** `ssoService.handleCallback` still maps mock/live profile **email** → `employees.findByEmail` when SSO enabled. Prepared chain exists in `ssoIdentityChainService` but is not wired to HTTP callback until `SSO_SUBJECT_CONTRACT_CONFIRMED`.

### 4.4 MJU Person Enrich → human review (offline)

```text
Operator CSV (names)
  → local script + Person API (Bearer in .env)
  → logs/person-cache.json + CSV outputs
  → operator: only match_count === 1 for auto-candidate prep
  → create employee_identity_links.status = 'candidate' (future admin API)
  → second reviewer approves → SSO allowed
```

Enrich output **does not** write to V2 DB. Evidence fields: `email_snapshot`, `personnel_id_snapshot`, optional `citizen_id_hash` after local hash — never raw citizen ID in V2.

```text
mju-person-enrich ──(local files only)──► operator review ──► employee_identity_links
                              ╳
                         V2 runtime / git / CI
```

---

## 5. Uniqueness and integrity rules

### 5.1 Current schema (as deployed in migrations)

| Entity | Uniqueness | FK |
|--------|------------|-----|
| `employees.employee_uid` | PK | — |
| `employees.employee_id`, `employees.email` | UNIQUE | — |
| `employee_identifier` | **No** UNIQUE on `(id_type, id_value)` | **No** FK to `employees` |
| `employee_identity_links` | UNIQUE `(provider_id, provider_subject)` | FK → `employees`, `identity_providers` |
| `daily_attendance.employee_uid` | Indexed only | **No** FK to `employees` |

### 5.2 Contract rules (application + future DDL)

1. At most **one active** mapping per `(identifier_type, identifier_value)` globally for operational IDs.
2. At most **one approved** link per `(employee_uid, provider_id)` for SSO.
3. `facescan_id` values must not collide across employees.
4. `employees.employee_id` remains unique; identifier row type `employee_id` must match parent row if both exist.
5. Duplicate `(id_type, id_value)` in onboarding → `DUPLICATE_IDENTIFIER` (dry-run today).
6. Attendance rows must reference a known `employee_uid` at import time (`ORPHAN_ATTENDANCE`).
7. **Do not** use `first_name` + `last_name` as a join key for production ingestion.

**Recommended future DDL (unresolved — see §8):** UNIQUE `(id_type, id_value)` where status active; FK `employee_identifier.employee_uid` → `employees.employee_uid`.

---

## 6. Privacy and logging rules

| Data | Rule |
|------|------|
| Citizen ID / `national_id` | Stored in `employee_identifier` for identity resolution only; no full values in logs, ordinary API responses, or UI; masked in `listIdentifiers`; never copied to attendance/leave/report tables |
| Person API token | Local `.env` only; never in repo, CI artifacts, or V2 config |
| `person-cache.json`, enrich CSVs | Local workstation; gitignored; not V2 runtime storage |
| SSO tokens / raw callback | Never persisted (see `IDENTITY_LINK_MODEL.md`) |
| `citizen_id_hash` | Preferred if V2 must remember a match artifact; algorithm and pepper **unresolved** |
| FaceScan / attendance logs | Log `employee_uid` or hashed external id; not national id |

`employeeIdentityService.resolveExternalId` must not log `national_id` values (comment in source).

---

## 7. Cross-repo field mapping (enrich → V2 evidence)

| mju-person-enrich output | V2 destination | Notes |
|--------------------------|----------------|-------|
| `citizen_id` (CSV) | **None** (local discard) or hash → `citizen_id_hash` | Never import raw |
| `email` / API `e_mail` | `email_snapshot` or compare to `employees.email` | Fix enrich scripts to read `e_mail` |
| `api_firstName` / `api_lastName` | Review UI only | Not stored as keys |
| (future) MJU personnel id from API | `personnel_id_snapshot` | Field not in current API cache |
| Approved SSO subject | `provider_subject` | From MJU contract, **not** from Person API |

---

## 8. Unresolved decisions

| # | Topic | Options / notes |
|---|--------|-----------------|
| U1 | MJU SSO subject claim name and shape | Adapter returns `unknown` until written contract (`SSO_SUBJECT_CONTRACT_CONFIRMED`) |
| U2 | Extend `employee_identifier.id_type` ENUM | Add `personnel_id` vs keep personnel in SSO snapshots only |
| U3 | Add `source_system`, `verified_at`, `status` to `employee_identifier` | New migration vs reuse `is_primary` + timestamps only |
| U4 | `citizen_id_hash` on identity links | Optional snapshot on links vs `national_id` row only |
| U5 | FaceScan staging tables in V2 | Migrate from legacy catalog vs new staging schema |
| U6 | Wire HTTP SSO callback to identity chain | Replace email-only `handleCallback` |
| U7 | Person API `personnelID` | Confirm with MJU whether filter API will expose stable personnel id for snapshots |
| U8 | Email field bug in enrich scripts | Scripts use `.email`; API returns `e_mail` — empty CSV email columns today |
| U9 | Unique FK on attendance tables | Add FK `daily_attendance.employee_uid` → `employees` for DB-enforced integrity |
| U10 | `sso_subject` in `employee_identifier` | Duplicative with `employee_identity_links` — recommend **no** unless needed for non-MJU OIDC |

---

## 9. Migration and implementation impact (design level)

**No migrations in Phase 3.** When implementation starts, expect:

| Area | Impact |
|------|--------|
| `employee_identifier` | ENUM extension; optional metadata columns; UNIQUE + FK; MariaDB repository; wire `employeeIdentityService` + container |
| SSO | Switch `ssoService.handleCallback` to `ssoIdentityChainService`; keep fail-closed gates |
| Onboarding | Allow controlled `national_id` hash rows if policy changes; today rows are dropped |
| FaceScan | Populate `facescan_id` identifiers; staging migrations TBD |
| mju-person-enrich | Read `e_mail`; stricter ambiguous handling; optional export format for candidate link CSV (no secrets) |
| Docs | Align `DATA_MAPPING.md` SSO email row with this contract when callback wired |

**Compatible preservation:** Keep `employee_uid` as sole canonical key; keep `employee_identity_links` for SSO; extend rather than replace `employee_identifier`.

---

## 10. Related documents and code

| Artifact | Path |
|----------|------|
| Identity links | `docs/IDENTITY_LINK_MODEL.md` |
| Enrich boundary | `docs/SSO_PERSON_ENRICHMENT_INTEGRATION.md` |
| Import mapping | `docs/DATA_MAPPING.md` |
| Identity service | `backend/src/services/employeeIdentityService.js` |
| Resolution / approval | `backend/src/services/identityResolutionService.js` |
| Local enrich repo | `G:\ProjectAI\mju-person-enrich` (operator tool) |

---

## 11. Next implementation step (after approval)

1. **Schema design PR:** `employee_identifier` repository + UNIQUE/FK + ENUM alignment with `ID_TYPES` (excluding duplicate SSO store).
2. **Implement `resolveExternalId`** for `facescan_id`, `employee_id`, `personnel_id` (if ENUM added).
3. **Do not** start attendance ingestion until FaceScan → uid resolution tests pass against fixtures.
4. **Parallel track:** MJU SSO subject contract confirmation and callback wiring (independent of enrich).

**Explicitly out of scope until later phases:** production deploy, data backfill, FaceScan staging cutover, Person API in backend.
