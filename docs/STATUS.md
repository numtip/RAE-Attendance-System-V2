# Status — 2026-10-21 (one page)

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