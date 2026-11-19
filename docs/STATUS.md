# Status — 2026-11-19 (current, closeout)

**Gate:** `RELEASE1_PRODUCTION_ACCEPTED` · Release 2 (M1 + leave + division dashboard + leave review) **LIVE**
**GitHub `main`:** `c9e856f` (PR #113) · **Production:** backend `dark-c9e856f`, frontend built from `c9e856f` · health/ready 200
**Day summary:** [`reports/DAY_SUMMARY_2026-11-19.md`](reports/DAY_SUMMARY_2026-11-19.md) · decisions **D-2026-11-19-01 … -08** in [`memory/DECISIONS.md`](memory/DECISIONS.md) · next actions [`memory/NEXT_ACTIONS.md`](memory/NEXT_ACTIONS.md)

## Evidence levels (read this before trusting a line below)

| Level | Meaning | Applies to |
|---|---|---|
| **CODE_MERGED** | on `main`, CI green | PR #100 – #113 |
| **PROD_DEPLOYED** | running on Production, health/ready verified, log 0 error, backups + rollback kept | everything below unless marked otherwise |
| **SYNTHETIC_QA** | UI and RBAC driven headlessly (1280/390 px) on a throwaway restore of Production with *synthetic* users; Production not touched | dashboard, leave report, leave review, exports |
| **REAL_USER_QA** | a real executive/employee session on Production | **only** the 2-account Release 1 UAT (`OWNER_UAT_ACCEPTED`). **Not yet done** for any Release 2 screen |

## Where Production is (counts only, no PII)

| Item | Value | Label |
|---|---|---|
| Workforce | employees **52** · org memberships **52** (3 divisions: 15 / 17 / 20) · approved SSO/identity links **49** · grants 1 (the sole executive) | PROD_DEPLOYED |
| Attendance | events **19,896** · daily **10,275** · monthly **569** (Jan–Nov 2026, AR-0001). **November is partial: HIP data covers 1–18 Nov 2026 only** | PROD_DEPLOYED |
| HIP-recorded leave | `employee_leave_record` **670** = **641 candidate** (607.5 days; 0.5-day AM/PM supported) + **29 needs_review**; `approval_status` all `unverified`; approvals/audit rows **0** | PROD_DEPLOYED |
| Official leave | `employee_leave` 0 · `leave_balance` 0 — no approval source exists; nothing is deducted | PROD_DEPLOYED |
| Schema | migrations through `031_leave_record_review.sql` (030: leave records + coverage; 031: reviewer columns + audit table) | PROD_DEPLOYED |
| UX | Thai-first design system, official org name `สำนักวิจัยและส่งเสริมวิชาการการเกษตร`, no absence KPI/column anywhere (API keeps `absent:null`) | PROD_DEPLOYED · SYNTHETIC_QA |
| Reports | personal, organization/team (PDF/XLSX), monthly leave (PDF/XLSX), executive dashboard by division, executive leave review; partial months show "ข้อมูลถึงวันที่ …" | PROD_DEPLOYED · SYNTHETIC_QA |
| Rollback | `prod-dark/frontend-dist.prev-<sha>`, `docker-compose.yml.bak-pre-<sha>`, `database/rollbacks/030_*.down.sql`, `031_*.down.sql`; a DB backup is taken before every write (backups directory on the host) | VERIFIED |

## Release 2 shipped today (PR → deployed SHA)

#106 org/team report → #107 Thai-first UX → #108 org name / no absence / daily names → #109 monthly leave + division dashboard → #110 HIP leave recovery (migration 030) → #111 recorded leave in dashboard + fixes → #112 "data through" notice → #113 leave review/approval (migration 031). Detail: day summary.

## Pending (owner / evidence, not code)

1. Executive Production click-through (REAL_USER_QA) of dashboard, leave report and leave review.
2. Review the 29 `needs_review` leave records (HR queue file is local and gitignored).
3. 30 leave records belong to one unmapped device code — see D-2026-11-19-08: consistent with a former employee, scans stay unmapped unless the owner decides otherwise.
4. HIP export for 19–30 Nov 2026.
5. Approve SSO links for the 3 pending employees (HMAC subject).
6. Decide the executive self-approval policy (an executive can approve their own leave; audited; there is one executive).
7. Policies still open: absence derivation (presentation is off by owner policy), holiday calendar, 2025 rules, official leave approval source and balances.

---

# Status — 2026-11-19 (morning checkpoint `dark-9578d77`, superseded by the section above)

**Gate:** `RELEASE1_PRODUCTION_ACCEPTED` (`OWNER_UAT_ACCEPTED`)
**Production:** **LIVE**, backend `dark-9578d77` (`origin/main` `9578d77`), frontend bundle `index-Bb-qr0aB`
**Reports:** [`reports/EOD_2026-11-19.md`](reports/EOD_2026-11-19.md) · [`reports/EOD_2026-11-19-2.md`](reports/EOD_2026-11-19-2.md) · [`reports/EOD_2026-11-19-3.md`](reports/EOD_2026-11-19-3.md) · [`reports/EOD_2026-11-19-4.md`](reports/EOD_2026-11-19-4.md)

| Item | Value | Label |
|---|---|---|
| Workforce | 52 employees (49 original + `1032`, `2019`, `3009` as `contract`), 52 `facescan_id`; approved SSO links 49 | VERIFIED |
| Attendance | 18,642 events · 9,627 daily · 517 monthly (Jan–Oct 2026, AR-0001; February 2026 imported); DB unchanged by the 9578d77 deploy | VERIFIED |
| Login page | MJU SSO only: rendered in a headless browser, 1 button, 0 inputs, no fixture text; `index.html` is `no-cache`, `/assets/` immutable (PR #103) | VERIFIED |
| SSO audit | a failed SSO callback writes `failed_login` / `via=mju_sso:<code>` with no uid or email (PR #104); a successful-login row is VERIFIED_BY_CODE_AND_SCHEMA; first real login after 9578d77 will confirm | VERIFIED |
| Reports | stale exclusions removed; absence shown as "ยังไม่คำนวณ" (PR #100); Feb/Mar monthly totals reconcile with daily rows; 3 formats share one `personal()` source (automated); owner accepted 2-account UAT | VERIFIED |
| Tooling | `facescan:derive` (PR #101) | VERIFIED |
| Rollback | images `dark-e15cb6d`/`dark-a6765b0`/`dark-21dea10`; `frontend-dist.prev-*`; compose backups; DB backups `…pre-deploy-9578d77…` and earlier | VERIFIED |

Pending: SSO links for the 3 new employees (owner approval) · November 2026 HIP export · holidays, absence derivation and 2025 policy.

---

# Status — 2026-11-18 (previous)

**Gate:** `DAY_20261118_CLOSED`
**Production:** **LIVE** at https://raeservice.mju.ac.th/attendance-v2/, with real HIP attendance for 49 employees (Jan, Mar–Oct 2026)
**Report:** [`reports/EOD_2026-11-18.md`](reports/EOD_2026-11-18.md) · decision **D-2026-11-18-01**

Today's work: PRs #94–#98 merged, the backend deployed as `dark-21dea10`, and 9 months of HIP files imported and derived.
The 2026-11-17 section below is kept as the historical record. Superseded rows are marked there; nothing was deleted.

## Where production is

| Item | Value | Label |
|---|---|---|
| `origin/main` | `21dea10` (PR #98) | VERIFIED |
| Deployed image | `rae-attendance-v2-backend:dark-21dea10` | VERIFIED |
| Workforce | 52: 49 onboarded, 3 pending (`1032`, `2019`, `3009`); 2 former (`1013`, `1015`) | OWNER_DECISION |
| Identity | employees 49 · `facescan_id` 49 · approved SSO links 49 · grants 1. Unchanged by the import | VERIFIED |
| HIP preflight | 12 CSVs, 22,950 scans (dry-run) | VERIFIED |
| Imported | 17,188 scans: 15,976 resolved, 1,212 unmapped (the 3 pending people and `1013`) | VERIFIED |
| Derived | 15,976 events · 8,245 `daily_attendance` · 441 `monthly_summary` (49 × 9 months), AR-0001 | VERIFIED |
| Backup | Taken before the import; restore checked in a throwaway container | VERIFIED |
| Report path | 49/49 employees have data in all 9 months through `reportService.personal`; cross-employee queries are refused | VERIFIED |

## Pending

1. Onboard the 3 pending people. This needs HR details and owner approval; it is blocked on evidence, not code.
2. SSO for the 3: HMAC subject plus owner approval (`1032` has no 2027 ID card).
3. Source gaps: February 2026 (xlsx only) and November 2026 (no export).
4. Oct–Dec 2025 needs a policy decision; AR-0001 covers only 2026.
5. Holiday calendar: `attendance_holiday` is empty and not read.
6. Missing-scan days are not derived, so `total_absent` is 0 (9,653 expected employee-days vs 8,245 rows).
7. Check a real employee's SSO login and report on the current dataset.

---

# Status — 2026-11-17 (historical, superseded)

**Gate:** `DAY_20261117_CLOSED`
**Production:** **LIVE** at https://raeservice.mju.ac.th/attendance-v2/ — `PRODUCTION_LIVE = YES`

Shipped today: MJU SSO activation, the first writer for `daily_attendance`, FaceScan → `attendance_events`
promotion, the staff self-read endpoint, roster onboarding, and production preflight/cutover scripts.
Everything below this section is the preserved 2026-10-21 record: superseded for current status, not deleted.

## Where production is

| Item | Value | Label |
|---|---|---|
| `origin/main` | `33f2c93` (PR #92) · CI 9/9 · Pages success | VERIFIED |
| Deployed image | `rae-attendance-v2-backend:dark-33f2c93` (compose project `rae-attendance-v2-dark`) | VERIFIED |
| Routed stack | dark backend `127.0.0.1:3260`, frontend `127.0.0.1:8094` (vhost markers `ATT-V2-DARK`) | VERIFIED |
| Database | `attendance_v2_prod_next` on `rae-v2-mariadb` — 28 tables from `main`'s 26 migrations | VERIFIED |
| Employees | 49 from the owner roster, department `สำนักวิจัยและบริการวิชาการ` | VERIFIED |
| Identity links | 49 approved · 0 candidate · 0 email-derived (`subject = HMAC-SHA256(citizenID)`) | VERIFIED |
| SSO | real MJU login end to end: provider → callback → session → authenticated read → logout | VERIFIED |
| Attendance data | `attendance_events=0`, `daily_attendance=0`, `monthly_summary=0` — no real scan data yet | VERIFIED (2026-11-17; superseded 2026-11-18) |
| Provider contract | `C-13 UNKNOWN`, `providerCertified=false`, owner risk acceptance v2 (12 items) | VERIFIED |
| Original database | `attendance_v2` untouched: 10 tables, 0 employees | VERIFIED |
| Legacy services | `attendance-api` and `rae-v2-*` still running and healthy | VERIFIED |

## Two things that will bite the next deployment

1. **DNS** — containers on this host resolve `sso.mju.ac.th` to the public address, which is unreachable.
   The unit must use the campus resolver (`dns: 10.1.255.20`), which resolves it to the internal
   `10.1.254.54`. Symptom when wrong: `SSO_PROVIDER_ERROR: The provider is unreachable`.
2. **Path prefix** — the `raeservice.mju.ac.th` vhost strips `/attendance-v2/` before proxying, so the SPA
   container must serve the bundle at `/`, not under the prefix. Otherwise the page 404s while the API
   answers 200.

Do not run `attv2-e2e-sso-route.sh enable --full-v2` in production: it points at the retired staging ports.

## Rollback

`sudo bash /home/rae_admin/sso/prod-cutover-route.sh disable` restores the vhost from the newest backup in
`/var/backups/attv2-e2e/`. Pre-cutover checkpoint: `/home/rae_admin/backups/golive-20261117T092209Z/`
(dumps of both databases, image tags, compose and env). The previous stack still runs on `3210`/`8088`.

## Next

HIP FaceScan file ingestion into `staging_facescan_raw` — `facescanRawIngestionService` exists but nothing
calls it (no route, no CLI) — then verify real `daily_attendance` / `monthly_summary` rows.

---

# Status — 2026-10-21 (historical, superseded)

**Gate:** `DAY_20261021_CLOSED_WITH_SECURITY_FOLLOWUP`
**Production:** **FROZEN.**

Not claimed: `PRODUCTION_READY`, `BASELINE_VERIFIED`, `ARCHITECTURE_APPROVED`, incident resolved.

> The release-1 status that preceded this page is **preserved at the bottom of this file** as a historical
> record. It is superseded for current status, not deleted.

---

## Where the work is

| Item | Value | Label |
|---|---|---|
| `origin/main` | **`2770657`** — PR #57, merged by the owner 2026-10-21 07:45Z | VERIFIED |
| Local `main` | `2770657`, synced ref-only (never checked out) | VERIFIED |
| Working checkout | `docs/r5-decision-review-20261019` @ `039c4e0`, **dirty, preserved** | VERIFIED |
| Working tree | 10 modified · **0 deleted** · 0 staged · 41 untracked | VERIFIED |
| Stashes | **2** | VERIFIED |
| Worktrees | **4** (all pre-existing) | VERIFIED |
| `origin/main` suite | **168 pass / 7 skipped / 0 fail**, eslint clean | VERIFIED |

## Open pull requests — all 8/8 CI, all `MERGEABLE`, **none merged**

| PR | What | Files |
|---|---|---|
| [#58](https://github.com/numtip/RAE-Attendance-System-V2/pull/58) | C2 — remove derived `employee_uid`, fail closed | 8 |
| [#59](https://github.com/numtip/RAE-Attendance-System-V2/pull/59) | SSO signout hardening | 8 |
| [#60](https://github.com/numtip/RAE-Attendance-System-V2/pull/60) | F9 — versioned HMAC national-ID lookup | 11 |
| [#61](https://github.com/numtip/RAE-Attendance-System-V2/pull/61) | migrations 015–024, verbatim | 21 |

## What is proven

| Claim | Label |
|---|---|
| F4 policy merged and live on `main`; zero migrations added | VERIFIED |
| Migrations 015–024 apply cleanly on MariaDB 10.6.23: **26/26**, second run **all skip** | VERIFIED |
| **31** schema assertions incl. raw national-ID rejected, `daily_attendance` still FK-free | VERIFIED |
| F9 HMAC: **13/13** on the 015 schema, **4/4** on main's schema | VERIFIED |
| F9 cross-version duplicate refused (was accepted — reproduced) | VERIFIED |
| Every branch verified in an **isolated extracted tree**, not the dirty checkout | VERIFIED |
| SSO signout refuses sample client ID, parent-domain cookie, open redirects | VERIFIED |
| Local engine is **10.6.23**; CI is **11.4** — not the same build | VERIFIED |

## Open P0

**A checksum-valid national ID is in public `origin/main` source and history.** 1 file, 2 distinct values, masks
`****5351` and `****0000`, reachable from **29** `origin/*` refs. The 2026-10-16 redaction commits were never on
`main`. PR #60 removes both from source; **history is untouched**.

**Status: contained in source pending #60 · not remediated in history · NOT RESOLVED.**
→ `docs/security/NATIONAL_ID_INCIDENT_20261021.md`

## Blockers on the import (not on the code)

`F5` verified effective dates (all 54 rows) · `F6` two names · `F10` the `1015` employee code · `F9` end-to-end
approval · `027` approval · `O-4`/`O-5` owner confirmation · `M1` migration order.

**0 of 54 rows are import-ready.** Attendance evidence needs no further work.

## Do not

Deploy · migrate a host · import · activate SSO · rewrite history · force-push · drop a stash · commit a roster,
ID-card file, `database/local/**` or any key · reproduce `****5351` in any encoding · quote one discrepancy number
as "the" count.
---

## Historical — release-1 status as of 2026-10-19 (preserved, superseded)

**Gate:** `DAY_20261019_CLOSED — RELEASE1_IN_PROGRESS`

Not claimed: `BASELINE_VERIFIED`, `ARCHITECTURE_APPROVED`, Production Ready.

### Where the work was

| Item | Value | Label |
|---|---|---|
| Code and import SHA | `d46199c2100b6da72af69ee36eea478f43ba3d5f` | VERIFIED |
| PR | [#50](https://github.com/numtip/RAE-Attendance-System-V2/pull/50) OPEN, not draft | VERIFIED |
| Branch | `feat/unified-attendance-fasttrack` | VERIFIED |
| CI on `d46199c` | 8/8 passed | VERIFIED |
| `origin/main` then | `398fcd9` (PR #49) | VERIFIED |
| Incident checkout | `docs/r5-decision-review-20261019` @ `039c4e0`, dirty | VERIFIED |
| Stashes | `stash@{0}` and `stash@{1}` still present | VERIFIED |

Release 1 scope stays SSO, personal attendance, leave, profile, and PDF/Excel reports. HR and executive surfaces
stay deferred.

### Release 1 progress

Personal report and self-only PDF/Excel export are on PR #50. Fixture QA and CI passed on `cbd7510` and the same
checks are green on `d46199c`. FY2569 verified events were loaded into disposable WSL MariaDB
`attendance_fy2569_local` for people present in the identity master. Months without a stored summary stay empty.
Missing days were not invented.

D-01–D-10 remain unsigned. Live host SHA, SSO gates, and whether migrations `025`/`026` are applied are UNKNOWN.

From 2026-10-20 the working rule is agent-first / human-on-blocker. Open owner questions are in
`docs/memory/OWNER_QUESTIONS.md`.

**Superseded on 2026-10-21** by the session status above. The 2026-10-19 figures describe that day; the live host
state is still UNKNOWN and has not been re-measured.