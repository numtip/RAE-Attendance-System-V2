# STATUS — 2026-11-24

**Gate:** `DAY_20261124_CLOSED`. Next phase: real-world usage, then feedback, then targeted fixes.

**Production is the `prod-dark` stack.** GitHub `main` `5b5ec41` (PR #146). Backend image
`rae-attendance-v2-backend:dark-5b5ec41`, healthy. Frontend bundle `index-Bzby0xSx.js`, base
`/attendance-v2/`. Schema through `037_thai_holidays_2026.sql`.

PR #144 `30ddd1d`, PR #145 `9eea54d`, and PR #146 `5b5ec41` are merged. CI for #146 was 9/9 before merge.
The isolated rehearsal and the production run of `holidayRecalculateCli.js 2026 --confirm` both reported
22 approved dates and 0 protected monthly summaries. The 10 summaries previously held back differed only
by stored early-departure minutes of zero; those now match the daily rows. Employee, identifier, identity-link,
event, daily, and monthly counts stayed 52 / 52 / 49 / 19,896 / 10,275 / 569. No daily row falls on an
approved 2026 holiday, so day statuses remain present 8,683 and late 1,592. Expected working days follow
the weekday calendar minus the approved weekday holidays. `total_absent` stays 0. The 16 December entry
remains a candidate pending MJU verification.

Fresh backup before the production write:
`/home/rae_admin/backups/attendance-v2/pre-hip-holiday-deploy-20261124T073909Z.sql.gz` (mode 0600).
Gzip, completion marker, and a restore into an isolated database matched the live counts. The earlier
`pre-hip-holiday-20261124.sql.gz` was not overwritten. The confirmed command also wrote its own dump under
the private runtime backup directory. Rollback copies: `prod-dark/docker-compose.yml.bak-pre-5b5ec41`,
`prod-dark/frontend-dist.prev-5b5ec41`, image `dark-3c0615b`.

Public smoke: login page renders, `/attendance/analytics` returns to login, 68/68 frontend files return 200,
health/ready 200, unauthenticated analytics and holiday routes return 401. No employee session was used.
Real-user QA of the HIP upload and holiday panels remains.

The backup mount is in `prod-dark/docker-compose.yml`
(`/home/rae_admin/backups/attendance-v2/runtime` → `/var/lib/attendance-backups`). A missing backup
directory returns `BACKUP_UNAVAILABLE` before a dump; that rejection was run with `node --test` and
did not use production. No redeploy was required.

# STATUS — 2026-11-20: see `docs/STATUS.md` and `docs/reports/DAY_SUMMARY_2026-11-20.md` (`main` `3d38715`, backend `dark-4bd7790`). The page below is the 2026-11-19 closeout.

# STATUS — 2026-11-19 closeout (one page)

**Gate:** `RELEASE1_PRODUCTION_ACCEPTED`; Release 2 live. **GitHub `main`** `c9e856f` (PR #113) · **Production** `dark-c9e856f`.
**Production is LIVE** at https://raeservice.mju.ac.th/attendance-v2/ (the 2026-10-20 / 10-21 "FROZEN" state below is superseded).

> Session-level one-pager. Release-level page: `docs/STATUS.md`. Full day: `docs/reports/DAY_SUMMARY_2026-11-19.md`.

## Evidence levels

* **CODE_MERGED** — PR #100–#113 on `main`, CI green.
* **PROD_DEPLOYED** — live on Production, health/ready 200, backups + rollback kept.
* **SYNTHETIC_QA** — headless UI/RBAC runs on a throwaway restore with synthetic users; Production untouched.
* **REAL_USER_QA** — a real session on Production. Done only for the Release 1 UAT (2 accounts). **Not done** for Release 2 screens.

## What is true now (counts only)

| Item | Value |
|---|---|
| Employees / org memberships / identity links | 52 / 52 (15·17·20 across 3 divisions) / 49 |
| Events / daily / monthly | 19,896 / 10,275 / 569 — November partial (1–18 Nov 2026) |
| HIP-recorded leave | 670 records: 641 candidate (607.5 days, incl. 0.5-day AM/PM) + 29 needs_review; all `unverified` |
| Approvals / audit rows | 0 / 0 — nobody has used the review screen yet |
| Official leave / balances | 0 / 0 (no approval source; nothing deducted) |
| Schema | through migration 031 |

## Shipped on 2026-11-19

Release 1 accepted · Release 2 M1 org/team report (PDF/XLSX) · Thai-first UX · official org name · no absence presentation ·
daily attendance with names · monthly leave report · 3-division executive dashboard · 52 division memberships imported ·
HIP leave recovery (0.5/1.0 day, AM/PM, review flags) · November HIP imported through 18 Nov · partial-month notice ·
executive leave review/approval with audit.

## Do not

* Re-import any HIP file that is already imported (idempotent, but pointless); re-run completed audits.
* Treat HIP-recorded leave as approved leave, deduct balances, or present absence.
* Add or change employees, identity links, grants or memberships without a separate owner approval.
* Commit raw HIP data, rosters, names, review queues or anything under `database/local/`; never `git add docs`.

---

# Historical — STATUS 2026-10-20 (superseded, preserved)

**Gate:** `EMPLOYEE_MASTER_SCHEMA_RESOLUTION` (attendance evidence complete; employee schema blocked)
**Production:** **FROZEN.** Not claimed: Production Ready, BASELINE_VERIFIED, ARCHITECTURE_APPROVED.

> This file is the session-level status. `docs/STATUS.md` remains the release-level status page for the
> PR #50 line of work and was **not** overwritten by this session.

## Where the work is

| Item | Value | Label |
|---|---|---|
| FY2569 primary exports | **12 / 12 hash-attested** | VERIFIED |
| Normalized attendance dataset | **19,345 rows**, 0 loss, 0 duplicates | VERIFIED |
| Owner-confirmed employee master | 54 codes, 1 workbook, untracked (PII) | VERIFIED |
| Employee schema import | **BLOCKED** (email, name split, employee_type, employee_uid) | BLOCKED |
| Data-recovery tests | 40 / 40 pass | VERIFIED |
| Backend suite | 526 pass, 12 skipped, 0 fail | VERIFIED |
| VPS-A / VPS-B | untouched this session | UNKNOWN (live state) |
| `origin/main` at session start | `6bec273` | VERIFIED |

## Identity

* **E1 resolved by owner:** `1015` and `1032` are **different people**. Never merge.
* `1032` = new employee, 11 months of evidence (337 rows).
* `1015` = resigned 03/2026, February only (28 rows), **preserved**.
* 0 shared calendar dates between them.
* Exact employment dates remain **unverified** — none invented.

## Data

* 19,345 source rows → 19,345 normalized rows. Status: present 10,168 / late 1,601 / leave 798 / absent 305 / holiday 6,473.
* 1,505 rows are `INFERRED` and each is itemised in `attendance_exceptions.csv`.
* Of 305 absences, 125 are stated by the source and 180 are inferred.

## Blockers (import only, not evidence)

F1 `employees.email` · F2 name split · F3 `employee_type` · F4 `employee_uid` policy · F5 effective dates ·
F6 names for `1013`/`1015` · F9 national-ID path · F10 `1015` employee code.

## Open conflicts (not resolved)

1. **Two identity bases.** `dataperson.csv` (phase0, with 19 excluded codes) is **not on disk**; the
   2026-10-20 owner master covers all 54 HIP codes with 0 exclusions. The 19-exclusion decision cannot be
   re-derived.
2. **24 / 25 / 26 discrepancy counts.** 26 register entries, 25 distinct person-months, 24 observed
   differences. 25-vs-24 is **not** demonstrated.

## Do not

Import into any production database. Apply migrations to a host. Enable SSO. Commit the owner workbook,
the ID-card CSV, `database/local/**`, or any HIP export. Quote a single discrepancy number as "the" count.

See `docs/memory/NEXT_STEPS.md` for the exact next actions.
