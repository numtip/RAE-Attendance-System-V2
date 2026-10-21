# ADR-012 — Employee UID allocation: UUIDv4, immutable, one person one UID, no automatic merge

**Status:** `ACCEPTED — OWNER APPROVED 2026-10-21` (policy only; **not** an import, deployment or SSO approval)
**Date:** 2026-10-21 · **Decider:** repo/data owner · **Workstream:** Employee Master F4
**Supersedes:** nothing · **Superseded by:** nothing
**Related:** F4 gate in [`../memory/SESSION_2026-10-20.md`](../memory/SESSION_2026-10-20.md) §7,
[`../IDENTITY_MAPPING_CONTRACT.md`](../IDENTITY_MAPPING_CONTRACT.md), migration `002_employees.sql`,
`013_employee_identifier_foundation.sql`. The durable schema fix is proposed in
`database/proposals/027_employee_uid_uuid_v4.up.sql` (not applied).

> **Ledger note (verified 2026-10-21).** The applied ledger on `main` is `001`–`014` plus `025`–`026`.
> Migrations `015`–`024` — the namespace triggers, `attendance_events`, and `employee_assignment` — exist only
> on the unmerged slice stack. Where this ADR cites one of those, the citation is marked **(slice stack)**;
> everything unmarked is present on `main`. This matters because a rule that depends on a trigger that is not
> on the base branch is a rule that silently does not run.

---

## 1. Context

`employees.employee_uid` is the primary key of the employee master and the value that every attendance row,
identifier row and identity link ultimately hangs off. Until this decision it was the one column with **no
approved source**: the 2026-10-20 rehearsal of the schema *as written* rejected the import with
`NOT NULL constraint failed: employees.employee_uid` and committed **0 rows**.

Three properties of the existing schema made an ad-hoc answer dangerous:

| Fact | Evidence |
|---|---|
| The database does **not** enforce the UID's shape. | `VARCHAR(36) NOT NULL`, no default, no CHECK, no generated column, no trigger (`002_employees.sql:2` — on `main`, verified). Any 36-character string is a valid primary key today. |
| Nothing in production code creates an `employees` row. | No `INSERT INTO employees` in `backend/src`; allocation existed only as a synthetic dry-run helper and an explicitly unapproved `uuid5` in the SQLite rehearsal harness. |
| Renaming a UID would not be blocked by referential integrity for most history. | `daily_attendance` (`004`) and `monthly_summary` (`005`) declare **no FK at all** (verified on `main`), so a re-key would silently orphan the normalized attendance rows rather than fail. `attendance_events` does hold a `RESTRICT` FK, but that table is `016` — **(slice stack)**, not on `main`. |

## 2. Decision

The owner approved the following policy on 2026-10-21:

> **UUIDv4 / Immutable / One Person One UID / No Automatic Identity Merge.**

Made concrete:

1. **UUIDv4, allocated once.** A verified *new* person receives one version-4 UUID, generated from a CSPRNG
   (`crypto.randomUUID`). It is validated as a v4 UUID at allocation time and again before it is written. A
   non-v4 value from the generator is rejected, not stored.
2. **Immutable.** A re-import of the same person reuses the stored value verbatim. There is no supported
   operation that changes an existing `employee_uid`; a caller proposing a different one fails closed
   (`EMPLOYEE_UID_IMMUTABLE`).
3. **Never derived.** The UID is not a function of the HIP/facescan code, the national ID, the RAE employee
   code, the email or the name. It must not be reproducible from a public input: a deterministic UUID would
   let anyone holding a HIP code compute a primary key, and would make "one person one UID" collapse back into
   "one code one UID" — the exact failure mode the identifier-namespace triggers exist to prevent.
4. **Identity is decided by identifier ownership only.** A match is proven by a value in
   `employee_identifier` (`facescan_id`, `national_id`, `employee_id`, `personnel_id`). An email or a name
   match never creates, merges or re-points an identity. It can corroborate a match an identifier already
   proved, and it produces a warning when it disagrees (a legitimate name or email change).
5. **A national ID is a lookup digest, never a raw key.** The database stores an HMAC lookahead for
   `national_id`, so a raw 13-digit value can never match a stored row. Matching therefore happens on
   `national_id_lookup` only: a candidate's raw value is converted with the injected `nationalIdLookup`, and if
   that is unavailable the row is **`QUARANTINE`** (`NATIONAL_ID_LOOKUP_UNAVAILABLE`) rather than `CREATE`.
   `POLICY.national_id_key = 'lookup_digest_only'` records the rule. Without this, a returning person whose only
   match is their national ID would be classified new and receive a **second UID** — the precise failure rule 3
   exists to prevent.
6. **No automatic merge.** Three situations are `CONFLICT` and are handed to a human; nothing is merged,
   deleted or re-pointed:
   * one identifier value owned by two different UIDs;
   * two strong identifiers that point at two different UIDs;
   * two candidate rows in one batch that claim the same identifier value.
   A candidate with **no** identifier (name or email only) is `QUARANTINE`, not `CREATE`. A caller-supplied
   UID must be unique in the batch and must be corroborated by an identifier; otherwise it could attach one
   person's identifiers to another person's UID.
7. **Absence is not removal.** A person missing from a later personnel export keeps their UID, their
   identifier rows and their attendance. Reconciliation reports; it never deletes.

## 3. Implementation

`backend/src/domain/employeeUidAllocation.js` — pure policy module, no I/O, no clock, no database:

| Export | Contract |
|---|---|
| `POLICY` | frozen descriptor: `uid_scheme: uuid_v4`, `immutable`, `one_person_one_uid`, `automatic_merge: false` |
| `allocateEmployeeUid({ existingUid?, uuidFactory? })` | `REUSE` when `existingUid` is present (generator not called), else `CREATE` from `uuidFactory()` **called with no arguments** |
| `assertEmployeeUidUnchanged({ employeeUid, proposedEmployeeUid })` | 409 `EMPLOYEE_UID_IMMUTABLE` on any other value |
| `assertNoAutomaticMerge({ sourceEmployeeUids })` | 409 `IDENTITY_MERGE_NOT_AUTOMATIC` for more than one distinct UID |
| `planIdentityAllocation({ candidates, existing, uuidFactory, nationalIdLookup })` | returns `CREATE` / `REUSE` / `QUARANTINE` / `CONFLICT` per candidate + a summary; never a write |

`planIdentityAllocation` is the piece that makes rule 4 enforceable rather than aspirational: the only lookup
it performs is `${identifier_type}:${value} -> Set(employeeUid)`. `name` is not in the index at all, and
`email` is consulted only to (a) refuse to match on it and (b) emit a warning. Because a stored national ID is a
digest, `national_id` is not a key type either — only `national_id_lookup` is.

## 4. Consequences

**Positive**

* A re-import is idempotent by construction: same identifiers, same UID, no regeneration. Verified against a
  synthetic 54-identity registry with a 49-row re-import: 49 `REUSE`, **0** `CREATE`, and the 5 out-of-roster
  identities never appear in the plan.
* `uk_employee_identifier_type_value` (migration `013`, on `main`) enforces one owner per identifier value, and
  the namespace triggers **(slice stack, `017`)** enforce the cross-type cases; this policy adds the UID-level
  rule the database cannot express.
* Ambiguity now has a vocabulary (`CONFLICT` / `QUARANTINE` + reason codes) and a test for each reason.

**Costs / accepted limitations**

* A `CONFLICT` row blocks **that row**, not the batch. A human queue is required before any import; that is
  intended, and no queue UI exists yet.
* The UID is opaque, so an operator cannot eyeball a UID and know who it is. That is the point, and it is why
  name/email lookups must go through the identifier layer rather than through the UID.
* **The database still does not enforce the UUID shape.** Rule 1 is enforced in one code path, not in the
  schema. The durable fix is `database/proposals/027_employee_uid_uuid_v4.up.sql` — an additive `CHECK`
  (`CHAR_LENGTH = 36` plus a v4 regex, MariaDB ≥ 10.2.3, consistent with migrations `015`/`020`), with a
  read-only `database/preflight/027_preflight.sql` that must report **0** non-conforming rows first. It is
  **proposed, not applied, and not engine-verified**, because migrations are frozen. Residual risk **R-F4a**
  stays open until it is approved and run against a real MariaDB.

## 5. Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| UUIDv5 from the HIP code (+ fixed namespace) | Deterministic and derivable from a public identifier; violates rule 3, and makes the UID guessable by anyone with the code. |
| Reuse the HIP/facescan code or the national ID as the key | Direct violation of rule 3, and it couples the primary key to a value that is protected by the HMAC contract for a reason. |
| Let the database allocate it (`DEFAULT UUID()`) | MySQL has no `UUID()` column default, and it would allocate a UID before a human verified the person — allocation must be a consequence of verification, not of an INSERT. |
| Merge by name + email when identifiers disagree | Names collide and change (marriage, transliteration); the 2026-10-20 workbook already had two people whose name fields could not be split. Rule 4/5 forbid it. |
| Keep the `previewEmployeeUid` deterministic preview as the real value | It is derived from `(batch id, sequence)` and documented as a preview to be regenerated; promoting it would create UIDs that depend on import order. |

## 6. What this ADR does **not** decide

* It does not approve an import, a migration, a deployment, SSO activation or any production change.
* It does not settle F1 (`email`), F2 (name split), F3 (`employee_type`), F5 (effective dates), F6 (names for
  two people), F9 (national-ID import path) or F10 (a missing employee code). Those keep their own gate
  entries in [`../EMPLOYEE_MASTER_F4_IDENTITY_POLICY.md`](../EMPLOYEE_MASTER_F4_IDENTITY_POLICY.md) §6.
* It does not allocate a UID for any real person. Allocation happens at an approved import, against verified
  identifiers; generating UIDs now would create identities nothing can verify.

## 7. Follow-ups

1. **R-F4a** — `database/proposals/027_employee_uid_uuid_v4.{up,down}.sql` plus
   `database/preflight/027_preflight.sql`. Numbered **027** because the applied `main` ledger already ends at
   `026`. Needs: a preflight run showing 0 non-conforming rows, a real-MariaDB application test, and the
   migration gate (`ADR-011`-style approval). Not requested by this change.
2. Import-time wiring: the plan must run inside the same transaction that inserts `employees` +
   `employee_identifier` (the atomic unit already described in `scripts/data-onboarding/lib.mjs`), so a
   partial failure cannot leave a UID with no identifier rows.
3. A human review surface for `CONFLICT`/`QUARANTINE` rows before the gate is lifted.
