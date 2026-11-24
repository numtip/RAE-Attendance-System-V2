# Next actions — as of 2026-11-24 (current)

**Gate:** `DAY_20261124_CLOSED`. Production `prod-dark` is on `main` `5b5ec41`, backend `dark-5b5ec41`,
migration 037, with 22 approved 2026 holidays and 16 December still a candidate. See `docs/memory/STATUS.md`
and the runbook section "Owner: HIP CSV and holidays". Next phase: real-world usage, then feedback, then
targeted fixes. Do not reopen SSO, Leave, or completed attendance audits.

The backup mount is in `prod-dark/docker-compose.yml`. Keep it when changing the image tag.
`deploy/production/cutover.sh` targets the older runtime.

| # | Action | Who | Notes |
|---|---|---|---|
| 1 | Use HIP upload and holiday management, then report what is wrong | owner | Organization scope on วิเคราะห์การเข้างาน. This is the remaining real-user QA |
| 2 | Confirm whether 16 December 2026 applies to MJU | owner | Seeded as `candidate` only |
| 3 | Provide the HIP export for 19–30 Nov 2026 | owner | Import is idempotent; approved holidays already reduce the working-day denominator |

**Gate:** `ATTENDANCE_DATA_COMPLETE = PARTIAL`. `main` `cf0d78b`. Resume from here; do not repeat completed work.
Attendance data readiness audit is done (read-only, see `docs/STATUS.md` 2026-11-24): 52/52 employees mapped, every available 2026 HIP file fully imported (scan counts equal batch rows exactly), events/daily/monthly reconcile, 328 unmapped scans are the two former employees by owner decision. **No import was needed; no production write was made.**

## Owner / evidence first (attendance data)

| # | Action | Who | Notes |
|---|---|---|---|
| 1 | Provide the HIP export for 19–30 Nov 2026 (and onward) | owner | Import is idempotent: `facescan:import <file> --format hip-daily --confirm --derive`; then daily/monthly reconcile automatically |
| 2 | Decide the MJU 2026 holiday calendar | owner | Done for 22 approved dates. 16 December remains a candidate |
| 3 | Decide the Oct–Dec 2025 classification policy | owner | Files are attested (1,962/1,937/1,863 scans) but AR-0001 approves 2026 only |
| 4 | Unchanged leave/identity items | owner | 29 `needs_review` leave records; SSO links for 3 pending employees; executive self-approval policy |

## Dashboard next (engineering)

Attendance Analytics Dashboard shipped in PR #143. Keep partial-month handling ("ข้อมูลถึงวันที่ …") and `absent: null` (D-2026-11-19-03).

---

# Next actions — as of 2026-11-20 closeout (historical)

**Gate:** `RELEASE1_PRODUCTION_ACCEPTED`; Release 2 live. `main` `3d38715`, backend `dark-4bd7790`, frontend from `4bd7790`. Resume from here; do not repeat completed work. Day: `docs/reports/DAY_SUMMARY_2026-11-20.md`, decisions D-2026-11-20-01 … -05.

## Owner / evidence first

| # | Action | Who | Notes |
|---|---|---|---|
| 1 | Real-session click-through of attendance, leave, reports, dashboard, leave review | owner / executive | Only the profile page has REAL_USER_QA; do not confirm an approval during the check |
| 2 | Onboard any person who is in the personnel file but not in the database | owner | The import reports them and never creates an employee |
| 3 | Copy `docs/reports/DAY_SUMMARY_2026-11-20.md` and `docs/memory/` into the Obsidian vault | owner | The vault is not reachable from the VPS |
| 4 | Items 1–6 of the 2026-11-19 list below are still open | owner | HIP export 19–30 Nov, 29 `needs_review` leave records, SSO links, self-approval policy |

## Operating rule added

Verify every deploy on the public domain. Production = `prod-dark` stack (see D-2026-11-20-04).

---

# Next actions — as of 2026-11-19 closeout (previous)

**Gate:** `RELEASE1_PRODUCTION_ACCEPTED`; Release 2 live on `dark-c9e856f` (`main` `c9e856f`). Resume from here; do not repeat completed work.

## Owner / evidence first (nothing below needs code)

| # | Action | Who | Notes |
|---|---|---|---|
| 1 | Executive Production click-through: dashboard, monthly leave, leave review | executive | Closes the REAL_USER_QA gap; all Release 2 QA so far is SYNTHETIC_QA |
| 2 | Decide the 29 `needs_review` leave records via the review screen | executive / HR | Each needs an explicit part of day to be approved; rejection excludes it from totals |
| 3 | Approve or leave the 30 leave records of the unmapped device code | owner | D-2026-11-19-08: matches a former employee; default = stay unmapped/skipped |
| 4 | Provide HIP export for 19–30 Nov 2026 | owner | Import with `facescan:import … --derive` then `leave:import-hip`; both are idempotent |
| 5 | Approve SSO links for the 3 pending employees | owner | HMAC subject from ID-card evidence; one employee has no 2027 card |
| 6 | Decide executive self-approval policy | owner | Today an executive can approve their own leave (audited, single executive) |

## Candidate engineering (only on request)

1. Block self-approval or add a second approver (RBAC change — needs a PR + security tests).
2. R2 M2: org-unit/multi-month filters; effective-dated division membership (membership table has no dates).
3. Per-record audit view in the review screen; export of decisions.
4. Mobile card layout for tables; WOFF2 fonts; dark mode.
5. Absence derivation / holiday calendar / 2025 rules — **policy first**; presentation of absence stays off.

## Operating rules

Production first: Build → CI → PR → Deploy → Test → Fix → Improve. PR-only merge, backup before every DB write, rollback ready.
Use `--confirm` only after a dry-run. Node 22 is at `$HOME/.nvm/versions/node/v22.23.2/bin`. Verify with a throwaway restore, never by impersonating a real user.

---

# Historical — next actions as of 2026-10-19 (superseded, preserved)

**Gate:** `DAY_20261019_CLOSED — RELEASE1_IN_PROGRESS`

Tomorrow starts on PR #50, not on the incident checkout. Owner policy from 2026-10-20: keep building the MVP while `docs/memory/OWNER_QUESTIONS.md` is unanswered. Do not import the excluded codes or the name-conflict events until the owner answers.

## First task

Finish verified-event personal reports on `feat/unified-attendance-fasttrack`:

1. Show only imported FY2569 events for the signed-in employee. Keep months with no stored rows empty.
2. Confirm PDF and Excel use the same rows, Thai labels, Buddhist year, employee code, date range, and totals.
3. Keep the import exclusions visible as counts: 19 unmatched codes, 5 name conflicts, 8 withheld review rows, and the 24-versus-26 person-month gap.
4. Re-run the focused tests: self access, cross-user denial, empty month, export, and the synthetic plan test.
5. Do not add HR or executive screens. Do not enable SSO. Do not apply migrations to any host but the disposable database.

## After that

| Order | Action | Why |
|---|---|---|
| 2 | Resolve the 24-versus-26 person-month difference from the prepared summary, counts only | The narrative and the file disagree |
| 3 | Decide whether the 19 codes absent from `dataperson.csv` stay excluded | Identity master rule |
| 4 | Owner signs or rejects D-07 and D-08, then D-02 with D-01a | Still unsigned |
| 5 | I0 containment, only with a separate approval | Host exposure was not re-checked |

## Do not do

Push to `main`, merge PR #50, open a VPS session, write a production database, or copy source rows into Git.
