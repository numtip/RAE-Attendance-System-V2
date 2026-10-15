# NEXT_ACTIONS — RAE Attendance System V2

**As of:** 2026-10-15. Ordered so that each item unblocks the next. Every item still needs its own approval,
branch and PR; nothing here authorises a push, merge, migration or deploy.

**Legend:** **VERIFIED** · **REPORTED** · **UNKNOWN**. Size: **S** ≈ hours, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

---

## 0. The immediate next milestone

> ### 🎯 Employee attendance reports (individual daily / monthly / FY)

This is the next development milestone. It is **blocked on policy approval, not on code**:

1. **Owner approves an attendance rule version (P-01/P-02).** Until then the engine always reports
   `pending_policy` and there is nothing to report. This is the single highest-value unblock — it is an
   owner decision, not engineering work. (Task **R-00**.)
2. Then **`monthly_summary`** can be derived from `daily_attendance` with the same provenance discipline
   (**R-01**), which is what an individual report actually needs.
3. Then the report surface itself (**R-02**), and exports/forms later (**R-03**).

Do **not** build the report UI on top of unapproved policy values — it would render a number nobody signed
off, which is exactly what the honesty gate exists to prevent.

## 1. Pending Slice 2 follow-ups

| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| **S2-H** | **The known gap: `agent/` is still not linted in CI.** The config now exists (`agent/eslint.config.js`, added `d279bba`) and the folder lints clean, but the `agent-core` CI job runs `npm test` only. | S | — | An `eslint` devDependency **plus a lockfile** exist for the `agent/` package, and CI runs `eslint .` so a lint error fails the build. Must be a pinned install, **not** `npx eslint@latest` |
| S2-A | Obtain owner approval for `AR-0001` (or a corrected policy) with `approved_by`/`approved_at` | S | P-01, P-02 | A synthetic fixture shows a real `late`/`present` result; no rule value invented by an agent |
| S2-B | Define and implement a night-shift lateness rule | M | **P-03** | `overnightLatenessPolicyMissing` disappears only when an approved threshold exists; a golden test pins it |
| S2-C | `monthly_summary` writer derived from `daily_attendance`, same provenance discipline | M | S2-A | Totals reconcile to the daily rows; a month is reproducible from its rule versions |
| S2-D | Holiday calendar import (approved source only) with checksum and owner | M | P-05, P-06 | Import is idempotent; unrelated `department` holidays are not applied |
| S2-E | Employee-scoped schedule onboarding (approved only) | M | P-02 | A pending schedule is reported, never applied; tests cover the boundary |
| S2-F | Retire the donor Attendance Core proxy routes behind a documented contract change | M | — | The contract change is documented and announced; no consumer breaks silently |
| S2-G | Verify the live Gateway decision path with one consenting credential (read-only smoke) | S | credentials | One `NEXT_ACTION` and one `QA_DISPOSITION` decision; the secret is never printed |
| S2-I | Leave-remark classification as an opt-in, owner-approved token set | M | **P-07** | Tokens come from an approved rule version, not a hardcoded list; false-positive cases tested |

## 2. Attendance reports — the next milestone, broken down

| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| R-00 | **Owner approves a rule version** (see §0) | S | owner | `AR-0001` (or its successor) is `approved` with a named approver and timestamp |
| R-01 | `monthly_summary` derived writer (`daily_attendance` → monthly aggregates, incl. `total_late_minutes`, `early_minutes`) | M | R-00, S2-A | Month totals equal the sum of its daily rows; every total carries rule version + cutoff |
| R-02 | `GET` report endpoints for one employee: day / month / academic year, scope-enforced | M | R-01 | 401 anonymous, 403 cross-scope; a report names its rule version, date cutoff and population |
| R-03 | Export layer (XLSX with Thai fonts, PDF, annual form) | L | R-02 | Server-enforced filters and export authorization; cross-scope export returns 403 in tests |
| R-04 | Reporting reconciliation test: recompute a closed month and match a frozen snapshot | M | R-02 | Recalculation of a past month reproduces the stored numbers exactly |

## 3. Slice 1 follow-ups still open

| ID | Task | Size | Depends on |
|---|---|---|---|
| S1-C | Admin CSV ingestion route: authenticated, admin-only, dry-run preview, no partial import | M | DT-06 |
| S1-D | Verify the HIP export header contract and freeze the column map (currently a candidate) | M | **D-04** |
| S1-E | Effective-dating write API (`setValidity`) + assignment window editing, with audit | M | — |
| S1-F | Load the authoritative employee master into `employees` + `employee_assignment` | L | **D-01** |
| S1-G | Frontend: assignment history on the profile page | M | S1-E |

## 4. Carried-over blockers from the handoff (not started)

`D-01` employee-master source · `D-02` legacy DB recovery · `DT-03` the pre-`013` ledger gap ·
`D-06` MJU `ac` semantics · `S-01`–`S-13` security items · `O-01` PR-stack drift (`#30 → #33 → #34/#35`).

## 5. Documentation and hygiene

| ID | Task | Size | Note |
|---|---|---|---|
| DOC-1 | Refresh `docs/SESSION_HANDOFF.md` with the Slice 1/2 status | S | **Needs approval** — it carries another session's uncommitted WIP (`HY-2`) |
| DOC-2 | Decide the fate of the stale branch `feat/attendance-core-service` (2 local-only, superseded commits) | S | **Needs approval** (`HY-1`); evidence in `PROJECT_STATE.md` §4a. Do not delete unilaterally |
| DOC-3 | Fold `docs/memory/*` into the Phase-1 document set once Slice 1/2 merge | S | — |

## 6. Standing rules discovered the hard way (do not relearn these)

1. **Never format a stored date with `String(value).slice(0, 10)`.** MariaDB returns a `Date` for
   `DATE`/`DATETIME` (the pool sets `timezone: 'Z'`); the fixture twins return strings. Use
   `wallDateOnly()` / `splitWallDateTime()`. **This has broken two consecutive slices**, and only the
   `backend-mariadb` CI job catches it. (`docs/unified/08_…` §4)
2. **The fixture/MariaDB twin pattern hides type divergence.** Local green is necessary but **not
   sufficient** for anything that reads a column.
3. **Never rename an applied migration.** The ledger keys on the full filename with no checksum.
4. **An unapproved rule must never produce a number.** If a feature needs a policy value, the answer is to
   ask the owner, not to add a default.
5. **Call `git.exe`, not the `git` shell function**, on this Windows host; write commit messages to a temp
   file and use `git commit -F`. Never `git add -A`.
