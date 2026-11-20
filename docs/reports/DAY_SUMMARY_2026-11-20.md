# Day summary — 2026-11-20 (sanitized)

**Production:** https://raeservice.mju.ac.th/attendance-v2/ · **`main`** `3d38715` (PR #123) · backend `dark-4bd7790`, frontend built from `4bd7790` (same code as `main`; only a test file differs) · schema through `033_employee_title.sql`
**Method:** Production first — Build → CI → PR → Deploy → Test → Fix; PR-only merges, each approved by the owner; a DB dump before every write; rollback kept.
**Sanitized:** counts and decisions only. No names, employee codes, secrets or server paths.

## What shipped

| PR | Summary | Level |
|---|---|---|
| #120 | Thai localization pass (leave-type and error-message maps, BE dates, BE year selector, Thai date picker, review banner behind `VITE_REVIEW_MODE`, sidebar group "สำหรับผู้บริหาร") + brand **RAE People Hub** with EN/TH subtitles from `config/organization.ts` | merged · deployed · SYNTHETIC_QA (375/768/1440 px) |
| #121 | status doc update | merged |
| #122 | profile data from the owner's personnel file: migration `032` (`procurement_academic`), `033` (`title_th`), `employees:import-profile` CLI, title shown on the profile page only | merged · deployed |
| #123 | status doc: schema, import counts, rollback locations | merged |

## Production data change (owner-approved, backed up)

* All **52** employees now carry position, division, personnel type and title from the owner's personnel file (49 in the first run, then the last 3 from rows the owner supplied). Names corrected for 4 people on the owner's confirmation. Roles and status unchanged (1 executive, 51 user).
* Four DB dumps taken before the writes (migration 032, the title migration, and each import run). the previous compose file and `frontend-dist.prev-*` copies kept for rollback.
* **REAL_USER_QA:** the owner checked "ข้อมูลของฉัน" on Production in a real session — passed.

## Mistakes worth not repeating

1. **Deployed to the wrong stack.** The public site is served by the `prod-dark` stack (`rae-v2-dark-frontend`, port 8094); the first frontend deploy went to the old `runtime` stack (8088), which the public domain does not use. Found only because the owner still saw the old name. Rule: verify through the public domain, never an internal port. `deploy/production/cutover.sh` targets the old stack.
2. **~1 minute of HTTP 500** during that first deploy: `rm -rf` of the dist directory failed on root-owned `assets/` after it had already removed `index.html`. Rule: never delete the dist directory; copy new assets first and `index.html` last, as root through Docker.
3. **A claim I had not checked** ("the 3 employees without data include the executive") was wrong; corrected after a query. Rule: query before stating.
4. **CI failed twice** on a literal BOM in a test file (`no-irregular-whitespace`); fixed with an escape before merge.

## Not done / open

* Authenticated screens other than the profile page (attendance, leave, reports, dashboard, review dialog) are still not checked in a real session.
* A person listed in the owner's file but not yet onboarded is only reported by the import, never created.
* Obsidian vault is not reachable from the VPS: these notes live in `docs/memory/` and `docs/reports/` and need to be copied into the vault from a machine that can reach it. Agent Core tools were not available in this session, so nothing was sent to it.
