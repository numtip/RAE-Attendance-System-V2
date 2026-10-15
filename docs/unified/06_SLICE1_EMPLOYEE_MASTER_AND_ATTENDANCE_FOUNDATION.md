# 06 — Slice 1: Employee Master + Attendance Data Foundation

Status: **`SLICE1_READY_FOR_REVIEW`** — implementation complete, tests green, **not pushed and not migrated anywhere**.
This document is the review artefact for the slice. It is not an approval and it authorises no host change.

Part of the Phase 0/1 document set for [RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md](../../RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md).
Read [`00_BASELINE_RECONCILIATION.md`](00_BASELINE_RECONCILIATION.md) first.

## 0. Provenance and scope

| Field | Value |
|---|---|
| Date | 2026-10-15 (Asia/Bangkok) |
| Branch | `feat/slice1-employee-master-foundation` |
| Base | `integration/attendance-sso-hip` @ `7d810d8` |
| Worktree | **None.** The branch was created in the single existing workspace, per `AGENTS.md` ("do not create Git worktrees") and `docs/SESSION_HANDOFF.md` §1. Blueprint conflict X-01 remains open at the owner level. |
| WIP | Untouched and uncommitted: `.ai/`, `AGENTS.md`, `.env.example`, `.gitignore`, `docs/SESSION_HANDOFF.md`, `docs/sampleCallback.aspx(.vb)`, the blueprint, `docs/unified/00`–`05`, `docs/06a_*`, `docs/07_*`, `docs/MJU_SSO_INVESTIGATION_20261015.md`, `docs/SSO_VPS_DEPLOYMENT_AUDIT.md`. `stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` are intact. |
| Hosts | **Not contacted.** No SSH, no production DB, no deploy, no migration applied anywhere. |
| Redaction | No PII, secret, token, national ID value or CSV value appears in this document or in any Slice 1 file. |
| Labels | **VERIFIED** (observed at the cited file/command), **REPORTED** (asserted elsewhere, not re-tested here), **UNKNOWN** (no evidence). |

**Scope decision (owner-approved for this slice):** *schema + contracts + ingestion foundation only*. No attendance
rule math, no `daily_attendance` writer, no reports, no dashboards, no exports, no SSO changes.
**Isolation decision (owner-approved):** in-place feature branch; no worktree.

## 1. Deliverable 1 — Feature inventory and reusable-component analysis

### 1.1 What already existed and was reused (VERIFIED)

| Area | Reused component | File | How Slice 1 uses it |
|---|---|---|---|
| Employee DTO safety | `publicFields` allowlist (10 fields, `password_hash`/`locked_until` never exposed) | `backend/src/repositories/employeeMapper.js` | Unchanged; the new assignment route cannot leak those fields because it returns assignment rows only. |
| Authorization | `resolveScope` / `assertInScope` / `canonicalRole` / `ROLES` | `backend/src/services/authorizationService.js`, `backend/src/services/access.js` | The new route calls `assertCanReadEmployee`; assignment writes require canonical `ADMIN`. |
| Error contract | `HttpError(status, code, message)` + `asyncRoute` + `success` | `backend/src/utils/*`, `backend/src/middleware/errorHandler.js` | Every new failure mode is a coded `HttpError`. |
| National-ID protection | HMAC lookup, `lookup_key_version`, `chk_employee_identifier_national_lookup`, one-national-id-per-employee key, `buildAuditEvent` PII guard | `backend/src/security/nationalIdContract.js`, migrations `015` | **Not weakened.** Slice 1 adds two nullable columns and one enum value; it changes no key, CHECK or trigger. |
| Namespace ownership | Migration `017` claim table + triggers | `database/migrations/017_identifier_namespace_claim.sql` | Untouched; still the DB-level guard against one value belonging to two employees. |
| Ingest pipeline | `normalizeCheckinoutRow`, `buildSourceEventKey`, `ingestCheckinoutBatch`, `staging_facescan_raw` unique keys | `backend/src/domain/facescanIngestion.js`, `backend/src/services/facescanIngestionService.js`, migrations `015`/`016` | The CSV adapter **delegates** to them; it does not reimplement validation, dedup or idempotency. |
| Fixture DI | `createFixtureRepositories` / `createMariaDbRepositories` twin-repository pattern | `backend/src/repositories/*` | A third twin pair (`employeeAssignment`) was added in the same shape. |
| Thai/Buddhist time | `bangkokTime` helpers | `backend/src/utils/bangkokTime.js` | Reused indirectly through `normalizeCheckinoutRow`; no new timezone logic. |

### 1.2 What did not exist before (VERIFIED gaps this slice closes)

| Gap | Evidence before Slice 1 | Closed by |
|---|---|---|
| No effective-dated employment attributes (`emp_code`/department/position history) | `002_employees.sql` is flat; `employee_id`, `department`, `position` are single current values. Grep for `effective|valid_from|assignment` over migrations returned only a comment line. | Migration `020` + `employee_assignment` module. |
| No validity window on an identity mapping | `employee_identifier` lifecycle was only `status ENUM('active','inactive')` + `verified_at`; unlink was an undated soft flag. | `effective_from`/`effective_to` + effective-dated resolution. |
| Ingestion could not accept a file | `ingestCheckinoutBatch` accepts a parsed array only; no CSV parser, no header contract, no upload/CLI; nothing in the repo mapped HIP CHECKINOUT headers. | `facescanCsv` + `facescanCsvIngestionService`. |
| No file provenance on an import batch | `facescan_import_batches` had counters and `source_reference` but no content hash, file name, parser version or column map. | Migration `021` + adapter wiring. |
| Attendance attribution ignored mapping validity | Ingestion resolved `facescan_id` → `employee_uid` with no date, so a scan could be attributed through a mapping that was not in force on the scan date. | Ingest now passes the scan date as `onDate`. |

### 1.3 Donor analysis (`G:\ProjectAI\attendance-report-generator`, `attendance-core`, `mju-person-enrich`)

Read-only inspection; **no file was copied**, and no donor data was read (paths, header names and row counts only).

| Donor artefact | Donor location | Decision | Rationale / constraint |
|---|---|---|---|
| HP Premium Time CSV reader (utf-8-sig, Thai header, remark re-join) | `attendance-report-generator/src/ingestion/csv_reader.py:7-53` | **Do not port (out of scope)** | It is a *daily summary* export, not raw CHECKINOUT. Slice 1 ingestion targets the HIP raw event shape only. Kept for a later reports slice. |
| Month auto-detection, Buddhist-year offset | `.../ingestion/employee_master.py:95-104`; `attendance-core/attendance_core/dates.py:6-33` | **Spec only, deferred** | Belongs to the reporting slice, not the data foundation. |
| Attendance rule engine (late/early/missing) | `attendance-core/attendance_core/engine.py:53-101` | **Deferred by scope** | Explicitly excluded from Slice 1; documented as a next-slice item with its own donor gaps (no overnight shifts, holiday handled in the caller). |
| Leave token list + Thai aliases | `attendance-core/attendance_core/leave_parser.py:5-30` | **Spec only, deferred** | Not needed for the foundation; the token list is not personal data but it is a policy contract that needs owner sign-off. |
| Employee-master loader | `attendance-report-generator/src/ingestion/employee_master.py:20-88` | **Do not reuse as-is** | It silently keeps the last row for a duplicate `employee_id` and reports no conflict. V2's `employee_assignment` rejects overlaps and reports `ASSIGNMENT_CODE_CONFLICT` instead. |
| HP→DataFrame dedup (last non-empty wins) | `.../engine/attendance_engine.py:28-44` | **Not adopted** | A silent last-wins merge is exactly the kind of unexplained number the blueprint forbids (§12). |
| `mju-person-enrich` name→identity matching | `mju-person-enrich/scripts/enrich-mju-person.mjs:120-158` | **Must not be reused** | Violates the standing rule "never match by name or email alone". |
| `mju-person-enrich` plaintext citizen-ID cache/output | `mju-person-enrich/logs/person-cache.json`, `output/*.csv` | **Must not be reused** | 13-digit IDs in plaintext on disk. V2 stores only an HMAC lookup. |
| Licence posture | No `LICENSE` in any donor; `attendance-core/README.md:129` says "Internal MJU / numtip project" | **Recorded, unresolved** | No donor code was copied, so no attribution obligation arose in this slice. If rule logic is ported later, record `attendance-core v0.1.0` as the behavioural source. |

## 2. Deliverable 2 — Architecture and DB contracts

### 2.1 Migration numbering decision

Two new files: **`020_employee_assignment_effective_dating.sql`** and **`021_facescan_ingestion_provenance.sql`**.

`018`/`019` are deliberately **skipped**: draft PR
[#35](https://github.com/numtip/RAE-Attendance-System-V2/pull/35) (`phase-d/sso-security-remediation`) already claims
those prefixes for `018_sso_consumed_code.sql` and `019_sso_shared_claim.sql`, and the runner's ledger keys on the
**full filename** with a lexicographic sort. Taking `020`/`021` keeps both branches applicable in either merge order
(the repo already carries two `013_` and two `015_` files for the same reason — `docs/SESSION_HANDOFF.md` §8).
**Do not rename either file after it has been applied anywhere.**

Every statement is `information_schema`-guarded, so a partial failure (DDL auto-commits and the runner's ledger is per
file) is repaired by re-running the same file. Both migrations are **additive** (new table, NULLable columns, one extra
enum value) and change no existing key or constraint.

**Required apply order — important.** `020` must be applied **before** this code is deployed. The identifier repository
selects `effective_from`/`effective_to` unconditionally and the audit insert names those columns, so on a database
without `020` **every** identifier lookup fails (`ER_BAD_FIELD_ERROR`) — including the MJU SSO national-ID lookup and
every FaceScan resolve. This is the same contract migration `015` already imposes on the same repository. The
migrations are therefore **NOT APPROVED for production**: the live ledger is pre-`013` (REPORTED), so no apply order
exists yet, and none is proposed here.

### 2.2 `employee_assignment` (new, migration 020)

```
assignment_uid   VARCHAR(36)  PK        -- uuid, one row = one validity interval of employment attributes
employee_uid     VARCHAR(36)  NOT NULL  -- FK employees.employee_uid
employee_code    VARCHAR(50)  NOT NULL  -- the emp_code in force during this interval
department       VARCHAR(100) NOT NULL
position         VARCHAR(100) NULL
employee_type    ENUM('university','department','contract') NOT NULL
effective_from   DATE         NOT NULL  -- inclusive
effective_to     DATE         NULL      -- inclusive; NULL = still open
source_system    VARCHAR(64)  NOT NULL
source_reference VARCHAR(255) NULL
recorded_at / created_at / updated_at DATETIME NOT NULL

UNIQUE KEY uk_employee_assignment_employee_from (employee_uid, effective_from)
CHECK chk_employee_assignment_window (effective_to IS NULL OR effective_to >= effective_from)
```

Invariants (each has a test):

1. `effective_to >= effective_from`. (DB CHECK **and** application.)
2. One row per `(employee_uid, effective_from)`.
3. **No overlapping windows for one employee** → `409 ASSIGNMENT_WINDOW_OVERLAP`. Enforced in the repository inside a
   transaction with `FOR UPDATE`, not only at the API.
4. **No two employees holding the same `employee_code` over overlapping windows** → `409 ASSIGNMENT_CODE_CONFLICT`.
   This is the blueprint's "ownership conflict evidence" (§8).
5. `employees` keeps the immutable UUID, login record and employment status; `employee_assignment` owns the mutable
   attributes over time. `employees.department`/`position`/`employee_id` remain the denormalised *current* values.

### 2.3 Effective-dated identity mapping (migration 020, extends `employee_identifier`)

```
employee_identifier += effective_from DATE NULL, effective_to DATE NULL
                       KEY idx_employee_identifier_effective (id_type, id_value, effective_to)
employee_identifier_access_audit += effective_from DATE NULL, effective_to DATE NULL
                                    action += 'effective_change'
```

Semantics:

* A date `D` is inside the window when `(effective_from IS NULL OR effective_from <= D) AND (effective_to IS NULL OR
  effective_to >= D)`. Both ends inclusive. `NULL` means "no bound".
* **`onDate = null` means "do not filter"**, which is exactly the pre-`020` behaviour. The SSO national-ID lookup and
  any caller that does not care about history therefore behave unchanged.
* A mapping outside its window resolves to *not found* — fail closed. It is **never** attributed to a different person.
* The security-critical keys are untouched: `uk_employee_identifier_type_value`, `uk_employee_identifier_national_owner`,
  `chk_employee_identifier_national_lookup` and the migration-017 namespace triggers keep their exact behaviour.
* **Deliberate limitation:** one identifier value keeps exactly one owner for its whole life (that is what the unique
  key guarantees), so a value has **one** validity window per row. Closing it early and re-opening it later extends the
  same row; a value moving to a *different* employee is impossible by design and requires a deliberate, audited
  operator decision — never a silent update.

### 2.4 Ingestion provenance (migration 021, extends `facescan_import_batches`)

```
facescan_import_batches += file_name VARCHAR(255) NULL, input_sha256 CHAR(64) NULL,
                           parser_version VARCHAR(32) NULL, column_map_json JSON NULL
                           KEY idx_facescan_import_batches_input_sha (input_sha256)
```

`input_sha256` is the SHA-256 of the raw input bytes, so a re-exported or edited file is detectable even when the row
counters look identical. `file_name` is a **base name only** (no host path). `column_map_json` records which header
mapping produced the rows, so a change in the source export can be explained instead of guessed.

### 2.5 API contract

| Method | Path | Auth | Behaviour |
|---|---|---|---|
| GET | `/api/v1/employees/:employeeUid/assignments` | Bearer + scope | Returns assignment rows, ordered by `effective_from` ASC. Optional `?onDate=YYYY-MM-DD` filters to the interval effective that day. |

| Status | Code | When |
|---|---|---|
| 401 | (auth middleware) | Missing/invalid token |
| 403 | `FORBIDDEN` | Caller outside scope (own-record rule for non-admin) |
| 400 | `ASSIGNMENT_INVALID_DATE` | Malformed `onDate` |
| 200 | — | `{ data: [...] }` |

No write endpoint is exposed in this slice: `create`/`close` exist at the service layer (ADMIN-only) and are covered by
tests. Opening an authenticated write route is a reviewed next-slice item — the same reason the CSV adapter is a service,
not an upload route.

### 2.6 Repository interfaces

`employeeAssignments` (fixture twin and MariaDB):

```
insert(input)                     -> record            // transactional: overlap + code-conflict checks
listByEmployeeUid(uid, { onDate, includeFuture })
findEffectiveOn(uid, date)        -> record | null
closeAssignment(uid, employeeUid, effectiveTo) -> record | null
```

`employeeIdentifiers` (added methods; existing ones unchanged):

```
findActiveByTypeAndValue(idType, idValue, ctx)   // ctx.onDate = optional validity filter
insert(input)                                    // now accepts effectiveFrom / effectiveTo
deactivate(id, employeeUid, { effectiveTo })     // 2-arg call still works
recordValidityEvent(input)                       // append-only 'effective_change' audit, metadata only
listValidityEvents({ employeeUid, limit })       // metadata-only timeline
```

### 2.7 Error codes added in this slice

| Code | Status | Source |
|---|---|---|
| `ASSIGNMENT_INVALID_EMPLOYEE` / `_CODE` / `_DEPARTMENT` / `_POSITION` / `_EMPLOYEE_TYPE` / `_SOURCE` | 400 | assignment domain |
| `ASSIGNMENT_INVALID_DATE` / `ASSIGNMENT_INVALID_WINDOW` | 400 | assignment domain |
| `ASSIGNMENT_WINDOW_OVERLAP` / `ASSIGNMENT_CODE_CONFLICT` / `ASSIGNMENT_DUPLICATE_EFFECTIVE_FROM` | 409 | assignment repository |
| `ASSIGNMENT_NOT_EFFECTIVE` | 404 | assignment service |
| `IDENTIFIER_INVALID_EFFECTIVE_DATE` / `IDENTIFIER_INVALID_EFFECTIVE_WINDOW` | 400 | validity domain |
| `CSV_EMPTY` / `CSV_UNTERMINATED_QUOTE` / `CSV_HEADER_MISSING` / `CSV_TOO_LARGE` / `CSV_NO_VALID_ROWS` | 400 | CSV adapter |

Every validator message is value-free by construction, and tests assert the rejected value is absent from the message.

## 3. Deliverable 3 — Implementation

| File | Change |
|---|---|
| `database/migrations/020_employee_assignment_effective_dating.sql` | New: `employee_assignment`, identifier validity window, audit columns + `effective_change` action. |
| `database/migrations/021_facescan_ingestion_provenance.sql` | New: four file-provenance columns on `facescan_import_batches`. |
| `database/rollbacks/020_*.down.sql`, `021_*.down.sql` | New: idempotent rollbacks (tracked via `!database/rollbacks/*.sql`). |
| `backend/src/domain/employeeAssignment.js` | New: pure validation, NULL-safe window overlap, effective-on check. |
| `backend/src/domain/identifierValidity.js` | New: pure validity-window rules (`normalizeValidityDate`, `isEffectiveOnDate`, `describeValidity`, …). |
| `backend/src/domain/facescanCsv.js` | New: RFC4180-ish CSV parser, candidate header alias map, structural validation, row projection. |
| `backend/src/repositories/{fixtureEmployeeAssignmentRepository.js, mariadb/employeeAssignmentMariaDbRepository.js}` | New: assignment repositories (twin pair). |
| `backend/src/services/employeeAssignmentService.js` | New: scope-enforced reads, ADMIN-only writes. |
| `backend/src/services/facescanCsvIngestionService.js` | New: `inspectCsv` (dry run) and `ingestCsv` (provenance + delegate to the existing ingest). |
| `backend/src/repositories/fixtureEmployeeIdentifierRepository.js`, `mariadb/employeeIdentifierMariaDbRepository.js` | Effective window in lookup, `insert`, `deactivate`; validity-event append/read. |
| `backend/src/services/employeeIdentityService.js` | `onDate` pass-through, `explainResolution`, `listValidityEvents`, window-aware link/unlink, windows in `listIdentifiers`. |
| `backend/src/services/facescanIngestionService.js` | Batch accepts file provenance; ingest resolves through the mapping effective **on the scan date**. |
| `backend/src/repositories/fixtureFacescanIngestionRepository.js`, `mariadb/facescanIngestionMariaDbRepository.js` | Persist/return the new provenance columns. |
| `backend/src/security/nationalIdContract.js` | `effective_change` audit action; audit event carries the window. **PII guard unchanged.** |
| `backend/src/api/v1/index.js`, `backend/src/controllers/employeeController.js` | New authenticated route. |
| `backend/src/repositories/fixtureRepositories.js`, `mariadbRepositories.js`, `backend/src/dev/fixtures.js` | Wiring + synthetic fixture rows. |

## 4. Deliverable 4 — QA evidence

All commands run on this host on 2026-10-15, on the working tree described in §0.

| Check | Command | Result |
|---|---|---|
| Lint | `cd backend && npm run lint` | **PASS** (exit 0, no output) |
| Backend suite | `cd backend && JWT_SECRET=… npm test` | **PASS** — `tests 256, pass 248, fail 0, skipped 8` |
| Effective-dating tests | `node --test tests/identifierValidity.test.js` | **PASS** 13/13 |
| Assignment module | `node --test tests/employeeAssignment.test.js` | **PASS** 23/23 |
| CSV adapter | `node --test tests/facescanCsv.test.js` | **PASS** 24/24 |
| API contract | `node --test tests/slice1Assignments.api.test.js` | **PASS** 1/1 (401 anonymous, 403 cross-scope, 400 bad date, 200 own + as-of date) |
| **Mutation A** — window check disabled in the fixture identifier lookup | `node --test tests/identifierValidity.test.js` | **PASS (detects it)** — 6 failures, including the ingestion assertion `resolved` vs `unmapped`; reverted, green again |
| **Mutation B** — `onDate` removed from `reResolveUnmapped` (§4.1 defect 1) | `node --test tests/identifierValidity.test.js` | **PASS (detects it)** — exactly 1 failure; reverted, green again |
| **Real database** — CI `backend-mariadb` (throw-away MariaDB 11.4, `db:migrate:seed` then the full suite) | `gh pr checks` | First run **FAILED** and exposed defect 5 (two failures in `reResolveUnmapped`); after the fix the job is green. This is the verification of the DDL and of the repository wiring. |
| Contract smoke | `node scripts/contract-smoke.mjs` | **PASS** (17 API_CONTRACT paths, `DATA_SOURCE=fixture`) |
| Frontend regression | `cd frontend && npm run build` | **PASS** (`vue-tsc --noEmit` + vite build) |
| Secret scan | `node scripts/secret-scan.mjs` | **PASS** (309 tracked files once the slice is staged; the script covers source files, and the new `.sql`/`.md` were reviewed by hand — they contain no identifier, key or credential) |
| PII review of every Slice 1 file | ripgrep for 13-digit runs and e-mail addresses | **PASS** — only synthetic `*@example.test` addresses and synthetic `9900…`/`9999…` test constants already present in the repo. One assignment test uses the marker `pii-marker-1180200015351` **specifically to prove** validator messages do not echo it. |
| Independent verification | separate verifier agent, asked to falsify §1–§4 | **4 defects found and fixed**, each with a regression test (§4.1) |
| No CSV / `database/local/` read | tool-call review | **PASS** — header names, paths and row counts only |
| No host contact | tool-call review | **PASS** — no SSH, no production DB, no deploy, no migration applied |

**Not run on this host, and covered by CI instead:** Docker and a local MariaDB are both unavailable here (`docker
version` → binary not found), so the two migrations were never applied to a database in this session. The
`backend-mariadb` CI job applies `001`–`021` to a throw-away MariaDB 11.4 and then runs the whole suite, which is where
`backend/tests/slice1.mariadb.test.js` (column presence, transactional overlap/code-conflict rejection, DATE round-trip,
"the audit trail holds no identifier value") actually executes. That job is the DDL verification, and it earned its keep
immediately — see defect 5 below.

### 4.1 Independent verification pass and the defects it found

This slice was reviewed by a separate verifier agent that was told to falsify the claims above. It reproduced the lint and
suite numbers, confirmed no security regression (the migration-015 keys, the national-ID CHECK and the migration-017
triggers are untouched; no new path can move a mapping between employees; no identifier value, national ID, password hash
or token leaks into a response, log, error or audit row) and then found four real defects. **All four were fixed and each
fix has a regression test.** A mutation proves the headline fix is load-bearing (removing the `onDate` from
`reResolveUnmapped` fails `reResolveUnmapped applies the same window rule as ingestion`).

| # | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| 1 | important | `reResolveUnmapped` resolved **without** `onDate`, so a re-run attributed a scan through a mapping that was not effective on the scan date — falsifying this slice's headline guarantee. The ingest path was fixed; the sibling re-resolve path was missed. | Pass the scan date, as the ingest path does. | `identifierValidity.test.js` → *reResolveUnmapped applies the same window rule as ingestion* |
| 2 | important | `closeAssignment` enforced only `effective_to >= effective_from`, so a row re-closed past a later interval produced **overlapping windows** (invariant 3 in §2.2 was insert-only), and the MariaDB version was a non-transactional read-then-write. | Transactional `FOR UPDATE` re-check of the closed window against the employee's other intervals; `409 ASSIGNMENT_WINDOW_OVERLAP`. | `employeeAssignment.test.js` → *closeAssignment may not create an overlap with a later interval* |
| 3 | important | Unknown `employee_uid`: the fixture repository succeeded silently while MariaDB surfaced `ER_NO_REFERENCED_ROW_2` as an opaque 500 — the twins disagreed. | Service checks the employee first → `404 ASSIGNMENT_UNKNOWN_EMPLOYEE`; the MariaDB FK error is coded the same way; the fixture twin accepts an `employeeExists` mirror of the FK. | `employeeAssignment.test.js` → *create rejects an unknown employee with 404 for both repository twins* |
| 4 | important | A `Date`-typed `onDate` was compared lexically by the fixture repository and read as *effective* — failing open on exactly the axis this slice is about, and diverging from MariaDB. | `resolveToEmployee` normalizes `ctx.onDate` once before it reaches any repository. | `identifierValidity.test.js` → *a non-string onDate is normalized, so the window is never silently skipped* |
| 5 | **blocker, caught by CI** | The fix for defect 1 derived the scan date with `String(row.checkTime).slice(0, 10)`. The fixture repository returns `checkTime` as a string, but MariaDB returns a `Date` (the pool sets `timezone: 'Z'`), so the expression produced `"Tue Mar 0"` and the window validator rejected it with `400` — every `reResolveUnmapped` against a real database failed. The fixture tests could not see it. | New shared, tested `wallDateOnly()` in `utils/bangkokTime.js`, used by both the ingest and re-resolve paths. | `identifierValidity.test.js` → *wallDateOnly reads a stored wall timestamp as the same day from a string or a Date* (asserts the naive expression is wrong, so the reason is preserved) |

Defect 5 is the important lesson of this slice: **the fixture/MariaDB twin pattern hides type divergence.** The fixture
twin returns strings, MariaDB returns `Date`s for `DATETIME`/`DATE` columns, and no local test could detect it — only the
`backend-mariadb` CI job did. Treat the local suite as necessary but not sufficient for anything that reads a column.

Also corrected from that pass: the §2.1 claim that the code works without migration `020` (it does not — see the required
order above); `column_map_json` now stores the mapping that was **actually applied** rather than the caller's override
(which made the provenance column useless for the default alias path); the two `toIsoDate` helpers and the two
date-input parsers were unified so the twins cannot drift; `describeValidity(record, null)` reports `effective` rather
than `unbounded` for a filtered-out-but-open query; and the `020` rollback documents that narrowing the `action` enum
fails loudly (error 1265) if `effective_change` rows exist, which is the safe behaviour.

Known remaining nits, deliberately not changed: `includeFuture` has no caller yet and reads "today" in UTC rather than
Asia/Bangkok; `CSV_NO_VALID_ROWS` triggers on *projected* rows, so a file whose every row has a bad timestamp still
creates a batch with `rowsFailed` set; `idx_employee_identifier_effective` cannot serve an `effective_from` predicate.
They are listed in §6.

## 5. Explicitly NOT done / unresolved in this slice

1. **No attendance rule math, no `daily_attendance` writer, no rule versioning.** `daily_attendance` still has no
   provenance columns; that depends on a decided rule contract (Phase-1 items `DT-09`/`DT-10`).
2. **No attendance HTTP route for CSV ingestion** and no admin import/preview/quarantine surface (`F-05`/`F-06`). The
   adapter is a tested service only.
3. **The HIP CSV header map is a CANDIDATE contract, not verified.** The real HIP export headers are unknown, so the
   default alias table mirrors only what `normalizeCheckinoutRow` already accepts, is case-insensitive, and is fully
   overridable per call. See `HIP_ID_FIELD_UNVERIFIED` in `docs/HIP_ID_MAPPING_EVIDENCE.md`.
4. **`employee_assignment` has no source of truth yet.** Decision `D-01` (which populated file is the authoritative
   employee master) is still owner-level, so no real rows are loaded and no import script is written.
5. **An assignment's validity window is set at insert and can only be closed**; editing a window afterwards is a
   next-slice operation. Same for re-opening a closed identifier window.
6. **`employee_identifier` still has no per-change history table.** The append-only audit trails transitions
   (actor, reason, window, timestamp); interval reconstruction beyond one window per value is not supported.
7. **No frontend** for assignments or ingestion.
8. **Carried-over Phase-1 blockers, untouched:** `D-02` legacy DB recovery, `D-04` HIP ID evidence, `D-06` MJU `ac`
   semantics, `D-07` live host gate values, `DT-03` the pre-`013` ledger gap, `S-01`–`S-13` security items, `O-01` PR-stack
   drift. Policy S9 was not modified in this slice.

## 6. Deliverable 5 — Next-slice backlog (proposal only)

Suggested order; every item still needs its own approval, branch and PR.

| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| S1-A | Attendance rule versioning + effective dates, ported from `attendance-core` with the donor gaps fixed (overnight shifts, holiday calendar owned by the engine, non-numeric employee ids) | L | `D-05`, owner sign-off on the policy values | Policy carries an id and effective dates; a historical recomputation is reproducible; golden-case parity test |
| S1-B | `daily_attendance` provenance: `source_system`, source-event reference, rule version, `calculated_at` | M | S1-A | Provenance columns populated by the writer; parity test asserts them |
| S1-C | Admin CSV ingestion route: authenticated, admin-only, dry-run preview, batch record, no partial import | M | `DT-06` | 401/403 unauthorised; preview diff reviewed; structural failures create no batch; audit row per batch |
| S1-D | Verify the HIP export header contract and record the evidence; then freeze the column map | M | `D-04` | Evidence recorded; the candidate map either confirmed or replaced; test updated |
| S1-E | Effective-dating write API (`setValidity`) + assignment window editing, with audit | M | this slice | Window edits are audited; overlap rules still enforced; regression test |
| S1-F | Load the authoritative employee master into `employees` + `employee_assignment` | L | `D-01` | Named source, checksum, owner; deterministic dry-run; reconciliation report |
| S1-G | Frontend: employee assignment history on the profile page | M | S1-E | Shows the interval effective for a chosen date; scope enforced server-side |
| S1-H | Carry the Slice 1 code into the review stack (`#30 → #33 → #34/#35`) and re-run CI | S | PR-stack decision | CI 8/8 green on the new base; migration order re-checked |

## 7. Review checklist for `SLICE1_READY_FOR_REVIEW`

- [ ] The migration-numbering decision in §2.1 is accepted (or `020`/`021` renamed **before** any apply).
- [ ] The one-window-per-identifier-value limitation in §2.3 is accepted.
- [ ] The candidate CSV header map in §5.3 is acceptable as a candidate (not a certified contract).
- [ ] An explicit decision is made about committing the pre-existing WIP listed in §0 — this slice does **not** commit it.
- [ ] Approval to push `feat/slice1-employee-master-foundation` and open a Draft PR (nothing is pushed yet).
