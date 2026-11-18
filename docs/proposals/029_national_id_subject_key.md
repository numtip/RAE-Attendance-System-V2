# Proposal 029 — stop the same person existing twice across HMAC key versions (N-6)

**Status:** `PROPOSED` — **NOT APPROVED, NOT APPLIED, NOT MERGED.** The DDL below was executed only against a
throwaway probe table in a disposable container, never against `employee_identifier`.
**Date:** 2026-10-29 · **Closes (if approved):** N-6 in [`../NATIONAL_ID_PROTECTION_POLICY.md`](../NATIONAL_ID_PROTECTION_POLICY.md)
**Depends on:** `013_employee_identifier_foundation` (`UNIQUE (id_type, id_value)`), `015_employee_identifier_secure_lookup` (`lookup_key_version`, `national_id_owner_uid`), and `scripts/national-id-key-versions.mjs` (N-2 tooling).

## 1. The defect, stated exactly

A national-ID digest is a function of **the raw ID and the key version**. The existing uniqueness is:

| Key | Scope | What it prevents |
|---|---|---|
| `UNIQUE (id_type, id_value)` (013) | one digest | the same digest twice — i.e. the same ID **under the same key version** |
| `UNIQUE (national_id_owner_uid)` (015) | one employee | two national IDs on one employee row |

Neither spans versions, so this is accepted today, silently:

```
v1 digest of N for employee B   -> inserts
v2 digest of N for employee C   -> ALSO inserts     (same person, two employees, two rows)
```

Consequence: one person can hold two identity rows after a rotation, and both resolve. The application probe is
also TOCTOU under concurrency — it reads, then writes, with no lock. That is N-6.

## 2. Option A — process only (no migration), recommended if rotation stays rare

Make rotation an **exclusive maintenance window**:

1. Before: `node scripts/national-id-key-versions.mjs` must exit **0** (no orphans).
2. Take writes offline (or the write path stops accepting `national_id` inserts).
3. Rotate: add the new key version, set it as the write version, run the reindex for every row still on the old
   version, then remove the old version.
4. After: the same command must still exit **0**, and a query must show exactly one live `national_id` row per
   `employee_uid`.

Cost: an operator procedure, no schema change. Weakness: it is a process, and a process is not enforced.

## 3. Option B — schema-level guard (this proposal)

Add a **rotation-invariant subject key**: the digest of the canonical ID under a **dedicated index key that is
never rotated** (`NATIONAL_ID_INDEX_KEY`), stored in its own column with a global unique index.

```sql
-- 029_national_id_subject_key.sql  (UP) — NOT the file name of an applied migration; see §6
ALTER TABLE employee_identifier
  ADD COLUMN national_id_subject_key CHAR(64) NULL DEFAULT NULL AFTER lookup_key_version;

CREATE UNIQUE INDEX uk_employee_identifier_national_subject
  ON employee_identifier (national_id_subject_key);

-- (DOWN)
DROP INDEX uk_employee_identifier_national_subject ON employee_identifier;
ALTER TABLE employee_identifier DROP COLUMN national_id_subject_key;
```

### Why a separate never-rotating key instead of reusing a rotating one

Any rotating key makes the guard version-scoped again — the defect returns. The index key's only job is
equality, so it never needs rotation; its exposure is bounded because a 64-hex digest of a 13-digit ID under an
unknown key is not reversible without the key. **This is a second secret to hold, which is the real cost.**

### Ordering, and why this cannot be applied in one step

1. Deploy the code that writes `national_id_subject_key` on every `national_id` insert (no schema dependency:
   the column is nullable, so an old schema simply has nowhere to put it — reconcile, do not crash).
2. Apply this migration.
3. Backfill: every existing `national_id` row needs its subject key, which requires the raw ID — **the
   application cannot derive it from a stored digest.** A row can only be backfilled from its source system.
   Until then its `national_id_subject_key` is `NULL`, and MariaDB allows many `NULL`s in a unique index, so the
   guard is **partial** — that must be stated, not implied.
4. After the backfill, tighten with `ALTER TABLE employee_identifier MODIFY national_id_subject_key CHAR(64) NOT NULL`
   in a *separate* migration, so a half-done backfill cannot masquerade as enforced.

### Why this is not a repeat of N-6 in a new place

The guard is `UNIQUE` on a value derived **only** from the raw ID, so it spans versions by construction. It
catches the cross-employee duplicate the current keys miss. It cannot catch a row that was never backfilled
(§4.3) — that is why the NOT NULL tightening is a second step rather than a claim.

## 4. What was actually tested (disposable container, 2026-10-29)

`backend/tests/proposal029_nationalIdSubjectKey.mariadb.test.js` (DB-gated, skipped without a database) clones
the table with `CREATE TABLE employee_identifier_probe029 LIKE employee_identifier`, applies the DDL above **to
the probe**, and asserts:

| # | Assertion | Result |
|---|---|---|
| 1 | MariaDB 10.11.14 accepts the column + unique index on a clone of the real table | PASS |
| 2 | two rows with the same `national_id_subject_key` are refused (`ER_DUP_ENTRY`) — even when their `id_value` digests differ (v1 vs v2) | PASS |
| 3 | two rows with different subject keys are accepted (so the index is not simply blocking every insert) | PASS |
| 4 | two `NULL` subject keys are accepted — the partial-guard property in §3.3, pinned rather than assumed | PASS |
| 5 | `DOWN` removes index and column, and `UP` re-applies cleanly | PASS |

The probe table is dropped in the test's cleanup; `employee_identifier` is never altered.

## 5. What this proposal does not prove

- It does not prove the backfill is possible: that depends on each source system still holding the raw IDs.
- It does not close the **TOCTOU** race in the application probe. The unique index does: a concurrent double
  insert now fails with `ER_DUP_ENTRY` instead of creating two rows, but the error path must map it to a
  reviewable outcome rather than a 500.
- It does not rotate or retire `NATIONAL_ID_INDEX_KEY`; dropping it orphans the guard exactly as dropping a
  lookup key orphans rows (use the N-2 tool).

## 6. Why this is Markdown and not `.sql`

`scripts/secret-scan.mjs` blocks any `.sql` outside `database/migrations`, `database/seeds` and
`database/rollbacks`, and the migration runner reads only `database/migrations/`. A Markdown proposal can be
reviewed in a diff and **cannot be applied by accident** — the same reasoning, and the same file, as
`027_employee_uid_uuid_v4.md`. When approved, the UP block is copied into
`database/migrations/029_national_id_subject_key.sql` under the normal gate, with a matching
`database/rollbacks/029_national_id_subject_key.down.sql` (16 of 26 migrations currently have no rollback —
this one does not add to that count).
