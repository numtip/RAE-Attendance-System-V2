# SSO and controlled onboarding progress — 2026-10-02

**Scope:** VPS read-only investigation, dry-run tooling, migration `013` on runtime `attendance_v2`, and documentation. **No employee import, no production deploy, no SSO activation.**

## Identity architecture (target)

Canonical person key: **`employees.employee_uid`** (generated UUID at approved import time; never derived from `employee_id` or `personnelId`).

External identifiers map through **`employee_identifier`**:

```text
national_id   ─┐  (uniqueness audited in batch prep; DB insert policy pending approval)
facescan_id     ─┼─► employee_uid
personnel_id    ─┘  (MJU Person API `personnelId`, authoritative when verified)
```

SSO runtime (still disabled): confirmed **`provider_subject`** via approved **`employee_identity_links`**, not email/name matching. MJU Person API enriches onboarding only; it is not the SSO provider.

## Browser / SSO handoff (unchanged gap)

Live MJU SSO remains **`SSO_ENABLED=false`**. Callback diagnostic can record **masked** callback field metadata only. **`SSO_USERINFO_PROBE`** is not implemented on the running backend image. Token handoff to the SPA after callback is still **UNKNOWN** (redirect `?sso=success` without browser tokens) — see `docs/SSO_ACTIVATION_RUNBOOK.md`.

## Pass summary (9.x → 9.5K)

| Pass | Focus | Outcome |
|---|---|---|
| 9.5F | Runtime snapshot vs onboarding | `attendance_v2` empty; no authoritative import batch in repo |
| VPS onboarding | Legacy vs V2 DB | Legacy `employees` unreadable (1932); V2 MariaDB empty |
| 9.5H | `personnelId` vs `employee_id` | **Likely match needs contract**; do not equate without approval |
| 9.5J | Migration + UID policy | **`013_personnel_identifier.sql`** applied on VPS; UID derivation removed from onboarding code |
| 9.5K | Import batch approval packet | 34 ready / 16 HOLD / 0 conflicts on the **synthetic** fixture only (tooling check; 34 is NOT an authoritative real-world count) |

## MJU Person API (operator-reported, not stored in git)

| Metric | Value |
|---|---|
| Deduped persons | 50 |
| MJU Find matched | 50 |
| `personnelId` present | 34 → **`PERSONNEL_ID_VERIFIED_FROM_MJU`** |
| Missing `personnelId` | 16 → **HOLD** |
| Duplicate `personnelId` | 0 |

Authoritative **deduped MJU + IDCard join file is not on the VPS** yet. Place under `.local/import-batches/` and run `prepare-import-batch.mjs`.

## Controlled onboarding design (in repo)

- **`personnel_id`** identifier type (migration 013).
- **`employee_id`:** immutable Attendance-local codes **`RAE-########`** (controlled sequence).
- **`employee_uid`:** UUID only; preview UUIDs in batch JSON are for approval packets — **regenerate at import**.
- Scripts: `scripts/data-onboarding/lib.mjs`, `prepare-import-batch.mjs`, `import-dry-run.mjs`.
- Docs: `PERSONNEL_ID_ONBOARDING_DESIGN.md`, `IMPORT_BATCH_APPROVAL.md`, updated `DATA_MAPPING.md`.

## Migration 013 (runtime VPS)

Applied manually to **`rae-v2-mariadb` / `attendance_v2`**: enum includes **`personnel_id`**; unique **`uk_employee_identifier_type_value (id_type, id_value)`**. Pre-migration schema snapshot stored encrypted under **`.local/onboarding-snapshots/`** (gitignored). Migrations **011–012** were not applied as part of this work.

## Tests (2026-10-02)

- Onboarding: **12/12** (`onboarding.test.mjs`) — personnel classification, batch build, UID policy.
- Backend: **63 pass**, 3 skipped MariaDB integration (when `RUN_MARIADB_TESTS` unset).
- Disposable MariaDB: migration 013 idempotency and rollback exercised on MariaDB 11.4 test container.

## Gates

| Gate | Status |
|---|---|
| `READY_FOR_MIGRATION_APPROVAL` (013) | **YES** (applied on VPS) |
| `READY_FOR_IMPORT_APPROVAL` | **NO** |
| Employee import performed | **NO** |
| Deploy / production restart | **NO** |

## Blockers

1. Authoritative real deduped MJU + IDCard batch on VPS with owner, timestamp, and `input_sha256`.
2. **National ID storage policy** — superseded: lookups now use HMAC-SHA-256 with key version (`national_id_lookup_hmac`); see `docs/NATIONAL_ID_PROTECTION_POLICY.md`. Raw `national_id` rows are not in the dry-run insert bundle.
3. Approved import window + fresh UUID allocation at insert time.
4. SSO: MJU subject contract, userinfo/token endpoints, and browser token handoff.

## Related commands

```bash
node scripts/data-onboarding/prepare-import-batch.mjs path/to/person-batch.json
node scripts/data-onboarding/import-dry-run.mjs .local/import-batches/<source_batch_id>.preview.json
node --test scripts/data-onboarding/onboarding.test.mjs
```
