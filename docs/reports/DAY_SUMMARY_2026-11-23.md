# Daily closeout — 2026-11-23

## Status
LEAVE_SOFTWARE_COMPLETE = YES; LEAVE_PRODUCTION_LIVE = YES; EMPLOYEE_DATA_COMPLETE = PARTIAL.
Source baseline main 017d432 (PR #140), verified via GitHub; production backend dark-017d432, frontend index-B1RpNuR1.js, prod-dark, engine ON, schema through 036, healthy (operator-reported). Runtime evidence below is from the day's operator handoffs, not independently re-measured here.

## Delivered today
| PR | Outcome |
|---|---|
| #126–128 | Annual/range leave reports, filters, status totals, division/person/detail tables, PDF/XLSX; personal list/history and approved-only balance from employee_leave_record; shared labels and personal report consistency. Deployed c5a5970. |
| #129 | Thai-first analytics dashboard with six KPIs, type/division/monthly charts, five tabs, scoped individual balance; removed N+1. Frontend ab3321f. |
| #130 | Pure versioned fiscal-year entitlement engine, 48 focused tests; c85aeb2. |
| #131 | CSV onboarding templates and Phase 2 design; 9d6e08e. |
| #132–134 | Additive migrations 034–036, profile/entitlement/import audit repositories, fiscal service, off/shadow/on flag, transactional dry-run/idempotent importer. Applied and deployed 9177c12 with flag off. |
| #135–136 | Personal fiscal balance UI, bulk scoped API, executive dashboard and audited owner edit. Deployed 6df3193; shadow matched single/bulk for 52 people, then flag ON. |
| #137 | Owner-only CSV/XLSX export, CSV upload/dry-run/confirm, bulk eligibility, baseline fields; f765b4a. |
| #138–140 | Multi-policy engine, contract policy V3 and explicit procurement mapping; d884218 → 2e0418b → 017d432. |

All 15 PRs #126–140 reported merged; CI 9/9 on final PR. Final local backend 616 pass and frontend 20 pass; MariaDB CI passed. Dashboard reconciliation 265/265 and multi-policy reconciliation 24/24 on disposable production restores. Legacy calendar responses unchanged in reported regression checks. Public health and assets verified by operator; authenticated production visual acceptance still not independently performed by agent. Owner accepted SSO functionality; no repeated individual UAT required (not evidence every account has an approved link).

## Policy decisions
Owner is project approval authority; no third-party approval gate. Fiscal year Oct 1–Sep 30. Focus on sick, personal and vacation; other types case by case.
| Type | People | Sick / personal / vacation (working days/FY) | Policy |
|---|---:|---|---|
| university | 28 | 60/45/10 | MJU-LEAVE-2569, effective 2026-08-21 |
| procurement_academic | 1 | 60/45/10 | Explicit same university policy, no assumed flag |
| department | 4 | 15/5/10 | RAE-SECTION-EMPLOYEE-2569 |
| contract | 19 | 10/5/10 | RAE-SECTION-CONTRACT-2570-V3, effective 2026-10-01 |

University first-year personal allowance 15; vacation tenure/carryover caps 20/30, subject to eligibility, continuity and owner decisions. Section personal requires 3 months, vacation 6 months; no carryover. Contract no tenure requirement, no carryover or prorating, vacation half-day units accepted, sick >3 consecutive working days certificate review flag only. Earlier contract years pending_policy. Unknown types remain needs_hr; explicit denial respected. All 19 contract confirmations already audited; do not repeat. No fabricated dates, balances, approvals or absence KPI. Approved eligible usage only, deduplicated by day/type; baseline cutoff prevents double deduction. Missing inputs/coverage remain unknown. Legacy calendar behavior preserved. Owner-confirmed overrides with provenance and discrepancy flags. Unresolved university/section mid-year and first-year interpretations remain pending decisions.

## Data checkpoint (operator-reported today)
Leave records 670: calendar 2025 (BE2568) 84, 74 recorded days, 0 approved days, 6 needs review; calendar 2026 (BE2569) 586, 533.5 recorded and approved days, 23 needs review. Approval audit changed during day through executive UI; no agent data writes during final deployment checks. These are calendar figures, not FY totals. No entitlement data fabricated. Mapping covers 52 active people; actual balances incomplete because employment dates, continuity, appointment kind and university carryover are missing where required. Owner can enter data or use CSV import; XLSX export must be saved as CSV for upload.

## Operational notes
- Production migrations 034–036 applied after backup and rehearsal on MariaDB 11.4.10; four new tables, 19 constraints. No further schema changes in later releases.
- Backups and frontend/compose rollback copies retained by operator; latest pre-procurement-mapping backup dated 20261123. Flag rollback: off and recreate backend; preserve data.
- PR #140 initial secrets check caught accidentally staged source files; clean branch merged. Old pushed refs/history not proven clean; targeted review if sensitive material was exposed. Stage explicit files only.
- Policy references: docs/policies/MJU_LEAVE_POLICY_2569.md, RAE_SECTION_CONTRACT_LEAVE_POLICY.md, HR_LEAVE_DATA_ONBOARDING.md. Do not commit raw source PDFs, personnel CSVs or PII.

## Next
Leave development closed unless actual defects found. Owner fills real data (29 university-policy + 4 section employees, university carryover etc.) and resolves pending interpretations as needed. Verify authenticated dashboard during normal use. Next engineering focus: Attendance Data Completeness (recheck current HIP coverage and unmapped scans before work), then Attendance Analytics using existing leave dashboard design baseline. No repeated SSO tests or unnecessary architecture changes.
