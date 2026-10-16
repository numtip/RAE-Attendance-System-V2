# `database/proposals/` — proposals, NOT migrations

**These files are not migrations. They are not applied. They are not in the migration ledger.**

This directory exists so that a design can be written down as real, reviewable SQL **without** turning it into
a production hazard. Read this before doing anything with a file in here.

---

## 1. What this directory is not

| Claim | Reality |
|---|---|
| "These are migrations" | **No.** They live in `database/proposals/`, not `database/migrations/`. |
| "The runner will apply them" | **No.** `scripts/migrate.mjs` lists `database/migrations/*.sql` only. Nothing in this directory is ever read by the runner. |
| "They are in `schema_migrations`" | **No.** The ledger (`schema_migrations.version`) keys on the **filename with no checksum**. A file here has no ledger row, ever. |
| "Approval to apply is implied by the code existing" | **No.** Applying is a separate, explicitly approved change (§3). |
| "They were executed while being written" | **No.** No database was connected to, no SQL was executed, no key was created or rotated. |

## 2. Why the directory is separate (the actual hazard)

`scripts/migrate.mjs` applies **every** `.sql` file in `database/migrations/`, in lexicographic filename order,
with:

* **no checksum** — editing an already-applied file is silently ignored on the next run;
* **no approval gate** — a file that merely *looks* applyable will be applied the next time the runner runs;
* **no rename safety** — the ledger stores the filename, so renaming an applied file makes it look new.

So a design proposal dropped into `database/migrations/` is not "a draft": to the runner it is a queued
migration. Putting proposals here makes the difference visible in the path itself. (See `ADR-008`: an applied
migration is never renamed.)

## 3. How a proposal becomes a migration

Each step is a **separate, approved change** — none of it happens automatically:

1. The proposal is reviewed and **approved** by the owner (and, for anything touching identity/evidence, the
   DBA/privacy path the design names).
2. It is **copied** into `database/migrations/` with the next free number. Migration numbers are
   **immutable once applied** — a typo in the number is not fixed by renaming later.
3. It is applied only in an approved window, on an approved target, by an approved operator.
4. Applying does **not** authorise the matching runtime code change; that is its own review.

## 4. Contents

| File | Purpose | Status |
|---|---|---|
| `025_identity_evidence.up.sql` | ID-6b / S-02: the `employee_identity_evidence` ledger + `employee_identity_links.evidence_type` mirror | **PROPOSAL — NOT APPLIED** |
| `025_identity_evidence.down.sql` | The matching rollback (drops the ledger; **data loss** — see its header) | **PROPOSAL — NOT APPLIED** |

Numbering check (2026-10-16): the highest existing migration filename is `024_monthly_summary_provenance.sql`;
`018_*`/`019_*` are reserved by draft PR #35; `020`–`024` are taken, and no `025_*` file exists in
`database/migrations/`. `025` is the next free number.

Design and rationale: [`docs/IDENTITY_EVIDENCE_MODEL.md`](../../docs/IDENTITY_EVIDENCE_MODEL.md),
[`docs/adr/ADR-011-identity-evidence-storage.md`](../../docs/adr/ADR-011-identity-evidence-storage.md).
Threats: [`docs/security/IDENTITY_EVIDENCE_THREAT_MODEL.md`](../../docs/security/IDENTITY_EVIDENCE_THREAT_MODEL.md).
Tests to write on activation: [`docs/security/IDENTITY_EVIDENCE_TEST_PLAN.md`](../../docs/security/IDENTITY_EVIDENCE_TEST_PLAN.md).

## 5. Rules for this directory

* **Do not** move a file out of here into `database/migrations/` as a "convenience" — that is the approved
  change in §3, or it is the hazard in §2.
* **Do not** run a file from here against any database, including a local one, as a "just to see".
* **Do not** put real national IDs, real names, secrets or CSV content in a file here (or anywhere). Test
  values are synthetic and **checksum-invalid**; see `docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`.
* A proposal should follow house migration conventions (`information_schema` guards, idempotency, explicit
  charset/collation, a real rollback) so that promoting it is a move, not a rewrite.
