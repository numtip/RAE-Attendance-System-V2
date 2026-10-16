# NEXT_ACTIONS — RAE Attendance System V2

**As of:** 2026-10-15. Ordered so that each item unblocks the next. Every item still needs its own approval,
branch and PR; nothing here authorises a push, merge, migration or deploy.

**Legend:** **VERIFIED** · **REPORTED** · **UNKNOWN**. Size: **S** ≈ hours, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

---

## 0. The immediate next milestone

> ### 🎯 Individual attendance reports (R-02)

**No longer blocked on policy.** On **2026-10-16 the owner approved `AR-0001`** (work `08:30–16:30`, late
after `08:30`, early before `16:30`, Mon–Fri), and **R-01 (monthly summary) is delivered** with provenance
and an honest completeness verdict. So a report now has real, traceable numbers to render.

Remaining before a report is *complete*:

1. **`expected_working_days` is working-week-only** until the holiday calendar is imported (S2-D). Correct,
   but a report will over-count expected days on holidays.
2. **Night-shift months report `partial`** until `P-03` defines overnight lateness (S2-B).
3. **`approved_by` is still a session label.** Name the accountable approver before these values are used
   for anything a person is judged on.

A report must **surface** `computation_status` rather than hide it: a `partial` or `pending_policy` month
must not be rendered as if it were final.

## 1. Pending Slice 2 follow-ups

| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| **S2-H** | **The known gap: `agent/` is still not linted in CI.** The config now exists (`agent/eslint.config.js`, added `d279bba`) and the folder lints clean, but the `agent-core` CI job runs `npm test` only. | S | — | An `eslint` devDependency **plus a lockfile** exist for the `agent/` package, and CI runs `eslint .` so a lint error fails the build. Must be a pinned install, **not** `npx eslint@latest` |
| S2-A | Obtain owner approval for `AR-0001` (or a corrected policy) with `approved_by`/`approved_at` | S | — | **Values approved 2026-10-16.** Remaining: replace the session label with the accountable person's name |
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
| ~~R-00~~ | ~~Owner approves a rule version~~ | — | — | **DONE 2026-10-16.** `AR-0001` approved for 2026. `approved_by` still needs a real name. |
| ~~R-01~~ | ~~`monthly_summary` derived writer~~ | — | — | **DONE — PR [#39](https://github.com/numtip/RAE-Attendance-System-V2/pull/39)**, migration `024`. Completeness verdict, provenance, idempotent, no phantom months. |
| R-02 | Report endpoints for one employee: day / month / academic year, scope-enforced | M | R-01 | 401 anonymous, 403 cross-scope; **every report names its rule version, date cutoff and population**, and surfaces `computation_status` instead of hiding a partial month |
| R-03 | Export layer (XLSX with Thai fonts, PDF, annual form) | L | R-02 | Server-enforced filters and export authorization; cross-scope export returns 403 in tests |
| R-04 | Reconciliation test: recompute a closed month and match a frozen synthetic snapshot | M | R-02 | Recalculation of a past month reproduces the stored numbers exactly |

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
2. **Never compare stored timestamps as strings.** A naive `'2031-11-03 23:00:00'` and an ISO
   `'2026-10-16T04:16:45.000Z'` do not order lexicographically — the separator and the year digits decide.
   Normalise to epoch millis first (`toEpochMillis` in `monthlySummaryService`). This produced a false
   `stale` in Slice 3. Same family as rule 1.
3. **An `await` is part of an authorization check.** `assertCanReadEmployee(...)` without `await` does not
   gate the response — the request proceeds and the rejection becomes an unhandled rejection. Slice 3
   shipped this in four places; only the negative-path test caught it.
4. **A month row aggregates DAY verdicts; it does not re-judge them.** Seeding a `calculated` day and
   expecting a `pending_policy` month is testing a fiction.
5. **Bound test fixtures.** An open-ended approved rule (no `effectiveTo`) covers every later date and
   leaks into other suites, because CI runs test files in parallel against one database.
6. **The fixture/MariaDB twin pattern hides type divergence.** Local green is necessary but **not
   sufficient** for anything that reads a column.
7. **Never rename an applied migration.** The ledger keys on the full filename with no checksum.
8. **An unapproved rule must never produce a number.** If a feature needs a policy value, the answer is to
   ask the owner, not to add a default.
9. **Call `git.exe`, not the `git` shell function**, on this Windows host; write commit messages to a temp
   file and use `git commit -F`. Never `git add -A`.
