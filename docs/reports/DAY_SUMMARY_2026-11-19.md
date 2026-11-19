# Day summary — 2026-11-19 (sanitized)

**Production:** https://raeservice.mju.ac.th/attendance-v2/ · **`main`** `c9e856f` (PR #113) · backend `dark-c9e856f`, frontend built from `c9e856f`
**Method:** Production first — Build → CI → PR → Deploy → Test → Fix → Improve; PR-only merges; a DB backup before every write; rollback kept.
**Sanitized:** counts and decisions only. No names, employee codes, device codes, raw HIP data, secrets or server paths.

## Evidence levels

| Level | Meaning |
|---|---|
| CODE_MERGED | on `main`, CI green (PR #100–#113) |
| PROD_DEPLOYED | live, health/ready 200, log 0 error, backups + rollback kept |
| SYNTHETIC_QA | UI/RBAC/exports driven headlessly (1280 and 390 px) on a throwaway restore of Production with synthetic users; Production untouched; totals cross-checked against SQL |
| REAL_USER_QA | a real session on Production — only the Release 1 two-account UAT. **Not done for any Release 2 screen.** |

## What shipped

| PR | Summary | Level |
|---|---|---|
| #100 | personal report: stale exclusions removed | merged · deployed |
| #101 | `facescan:derive` tool (dry-run default) | merged · deployed |
| #103 | login page: MJU SSO only; cache headers | merged · deployed |
| #104 | SSO audit rows use valid `auth_logs` event types | merged · deployed |
| #105 | compute endpoints authorize by data scope, per employee, bounded | merged · deployed |
| #106 | Release 2 M1: organization/team report + PDF/XLSX | merged · deployed · synthetic QA |
| #107 | Thai-first design system (Sarabun bundled, grouped nav, KPI tiles, responsive tables) | merged · deployed · synthetic QA |
| #108 | official org name (central constant); no absence anywhere in UI/PDF/XLSX; daily attendance shows name + id (server-side, scope-filtered) | merged · deployed · synthetic QA |
| #109 | monthly leave report; executive dashboard by division with reconciliation banner and drill-down; `org:import-divisions` | merged · deployed · synthetic QA |
| #110 | migration 030 + `leave:import-hip`: leave recovered from HIP `Remark [n]`, 0.5/1.0 day with AM/PM, review flags | merged · deployed · synthetic QA |
| #111 | dashboard/org/personal reports use HIP-recorded leave (was showing 0); mobile detail clipping fixed | merged · deployed · synthetic QA |
| #112 | "data through" notice for partial months | merged · deployed |
| #113 | migration 031 + executive leave review/approval with audit trail | merged · deployed · synthetic QA |

## Production data changes (each after a backup; each idempotent)

1. 52 division memberships (15 / 17 / 20), insert-only.
2. HIP leave recovery for 13 monthly files (Oct 2025 – Oct 2026): 667 rows carried a leave remark → 637 recorded, 30 skipped (one unmapped device code).
3. November 2026 HIP file (**1–18 Nov only**): 1,254 scan rows (all device codes mapped), 648 daily days, 52 monthly summaries, 30 leave records.
4. Three leave entries stated directly by the owner (source `owner_manual_entry`, still `unverified`).
5. Not changed: roles, grants, identity links, employees, official leave, balances.

## Counts now (verified read-only on Production)

| Item | Value |
|---|---|
| employees / memberships / identity links / grants | 52 / 52 / 49 / 1 |
| events / daily / monthly | 19,896 / 10,275 / 569 |
| HIP-recorded leave records | 670 = 641 candidate (607.5 days) + 29 needs_review |
| approvals / audit rows | 0 / 0 |
| official leave / balances | 0 / 0 |
| HIP leave, Oct 2025 – Oct 2026 | 576.5 days = 545 full + 63 half-days (24 AM, 39 PM) × 0.5 |
| HIP leave, Nov 2026 (1–18 Nov) | 28.5 days |

## Defects found and fixed today (via real-data QA on a throwaway restore)

Dashboard showed leave = 0 while the leave report showed 52 days for March (monthly summary leave is never derived) · expanded leave details clipped on mobile · a footnote claimed half-days were unsupported · an empty dropdown placeholder · a PDF test coupled to glyph order.

## Owner decisions (recorded in `docs/memory/DECISIONS.md` D-2026-11-19-01 … -08)

Release 1 accepted on two-account UAT · official organization name · employees are not classified absent · three divisions and their memberships · leave recorded from HIP remarks, never treated as approved · November file is partial · the executive keeps the executive role and a review screen is built instead of an `admin` switch · the unmapped leave device code is not onboarded.

## Rules that held all day

No absence KPIs; no invented approvals, balances, holidays or identities; HIP-recorded leave is separate from official leave; ambiguous rows are `needs_review`, never counted; SSO and RBAC untouched; no new privilege granted implicitly.

## Remaining blockers

See `docs/memory/NEXT_ACTIONS.md`: executive Production click-through · review the 29 leave cases · the 30 unmapped-code leave records (default: stay skipped) · HIP export for 19–30 Nov · SSO links for the 3 pending employees · executive self-approval policy · policies (absence derivation, holiday calendar, 2025 rules, official leave approval source).
