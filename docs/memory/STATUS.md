# STATUS — 2026-10-20 (one page)

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
