# ADR-013 — Migration numbering: sort order is a dependency, so it is tested

**Status:** `ACCEPTED` (engineering rule, 2026-10-29) · **Decider:** repo/DB owner
**Supersedes:** nothing · **Superseded by:** nothing
**Related:** [`../../database/migrations/015_facescan_hip_ingestion.sql`](../../database/migrations/015_facescan_hip_ingestion.sql) (version note),
`backend/tests/migrationOrdering.test.js`, `scripts/migrate.mjs`, `docs/memory/DECISIONS.md` (D-2026-10-21-07 on rollback retry)

> **Ledger note (verified 2026-10-29):** `main` carries `001`–`017`, `020`–`026`, `028` — with the
> numeric prefix `015` used by **two** files. `018`/`019` are reserved by draft PR #35, `027` is a
> proposal, and nothing here has ever been applied to a host.

---

## Context

`scripts/migrate.mjs` applies migration files in **filename sort order** (`:99`) and records
completion in a ledger keyed on the **filename** (`:9`), not on a parsed version number. That means
the numeric prefix is cosmetic, and the sort order is the real dependency order.

On 2026-10-29 we tried to remove the duplicate `015` prefix by renumbering
`015_employee_identifier_secure_lookup.sql` → `029_…`. The reasoning looked sound — grep showed
nothing later referencing the column that file adds — and the change passed local tests, lint and the
secret scan. It failed CI's MariaDB job:

```text
apply 020_employee_assignment_effective_dating.sql
Table 'attendance_v2.employee_identifier_access_audit' doesn't exist
```

The file also creates two **tables**, and `020_…:106-121` alters one of them. Moving it to `029` moved
it after a dependent. The Grep had looked for `lookup_key_version` (a column) and not for
`employee_identifier_access_audit` (a table).

The duplicate remains, and it is **load-bearing**:

| Sort position | File | Depends on / is depended on |
|---|---|---|
| 1 | `015_employee_identifier_secure_lookup` | creates `employee_identifier_secret`, `employee_identifier_access_audit`; `020` alters the latter |
| 2 | `015_facescan_hip_ingestion` | creates `staging_facescan_raw`, `facescan_import_batches`; `016` and `021` reference them |
| 3 | `016_attendance_events`, `017_…`, `020_…` | must run last of this group |

Neither file can move and there is no free number between `017` and `020`.

## Decision

1. **A migration's position in sort order is a dependency**, and it is stated in the file itself when
   it is not obvious. A comment in the file is the cheapest place for the next reader to find it.
2. **The order is asserted by a test**, not by memory: `backend/tests/migrationOrdering.test.js` pins
   the adjacency of the two `015` files, `secure_lookup` before `020`, `facescan` before `016` and
   `021`, and the continued absence of `018`/`019`.
3. **Renumbering is allowed only when the whole dependency closure moves with it**, and only before
   the first apply on any host. A rename that changes only one file is a change to the order of the
   chain, so it needs the same review as a schema change.
4. **Verify by table, not by column.** When checking whether something later depends on a migration,
   grep for everything it creates — tables, columns, constraints, indexes — not only the first name
   that comes to mind.

## Consequences

**Positive:** the next person who "fixes" the duplicate number fails locally in seconds instead of
discovering it in the MariaDB job. The rule generalises: every ordering assumption in the chain now
has a test or a comment.

**Negative / accepted:** two files keep a confusing shared prefix until the dependency closure is
renumbered in one deliberate change (pilot: `020` and everything reading its effective-dating columns).
That is a real, documented cost, preferred over a silent ordering change.

**Explicitly rejected:** renumbering a single file to make the numbers look tidy. Cosmetic gains do
not justify changing the order in which DDL executes.

## Compliance

A migration PR is compliant only if: (a) any new dependency on sort order is stated in the file,
(b) `backend/tests/migrationOrdering.test.js` still passes, and (c) the MariaDB job is green — a local
run cannot see ordering failures, because the DB-gated tests skip without a database.
