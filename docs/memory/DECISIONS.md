# DECISIONS — append-only log

**Purpose:** one place for decisions that must not be silently re-litigated by a later agent.
**Rule:** append dated entries. Never rewrite or delete an earlier verdict. If a decision is reversed, add
a new entry that names the one it supersedes.

> **History note.** This file did not exist on `origin/main` before 2026-10-20. The pre-2026-10-20 decision
> table (`D-A` … `D-H`) lives in `docs/memory/DECISIONS.md` **on the incident checkout
> `docs/r5-decision-review-20261019`**, which is preserved WIP and is not the restart branch. Those entries
> are summarised in §0 below for continuity only; the authoritative text remains on that branch.

---

## 0. Carried forward from earlier sessions (summary, not authoritative)

| ID | Decision | Note |
|---|---|---|
| D-E | Attendance rule values approved 2026-10-16: work 08:30–16:30, late after 08:30, early before 16:30, Mon–Fri, 2026 calendar year. | `AR-0001` approved; `AR-0002` (2027) stays pending. The approver is a session label, not a named person. |
| D-F | Jev (Agent Core) is consulted once at the start of every session. | Enforced by `.cursor/rules/agent-core-jev.mdc`. |
| D-G | The Jev consult is **advisory only**; on failure, report and continue. One call per session. | Must never block work. |
| D-H | 2026-10-19: Option A — ship the security slice to `origin/main` rather than the incident branch. | PR #49 squash-merged as `398fcd9`. |

---

## 2026-10-20

### D-2026-10-20-01 — `1015` and `1032` are distinct people (E1)

**Decision:** `1032` and `1015` are **different natural persons**. Their identities and their attendance
must never be merged.

* `1032` — new employee, evidence in **11 of 12** FY2569 exports.
* `1015` — resigned March 2026; **February 2026 attendance must be preserved**.

**Grade:** `OWNER_CONFIRMED`. **Status:** settled — do not re-open.
**Why this needed a decision:** February's export contains `1015` and omits `1032` (a 1-for-1 swap with an
identical department). The exports alone cannot distinguish "legacy code for the same person" from "two
people". The owner resolved it; the evidence (§1 of `docs/reports/EOD_2026-10-20.md`) is consistent with the
decision but could not have produced it.

### D-2026-10-20-02 — FY2569 attendance data approved for use

**Decision:** the FY2569 attendance data is approved for use.
**Grade:** `OWNER_CONFIRMED`. Approved for **dataset and rehearsal** use — this is **not** approval to
import into production. See D-2026-10-20-04.

### D-2026-10-20-03 — Employment dates stay unverified; nothing is invented

**Decision:** exact employment start/end dates remain unverified, and no date is to be inferred to satisfy
a `NOT NULL` or to populate `employee_assignment`.
**Grade:** `OWNER_CONFIRMED`.

### D-2026-10-20-04 — Attendance evidence is complete; the employee schema is the only remaining gate

**Decision:** no further evidence work is required for FY2569 attendance (12/12 exports hash-attested,
19,345 rows reconciled, 0 unexplained loss). The import gate is **exclusively** the employee schema.
**Grade:** `VERIFIED`.
**Supersedes:** any implication in the earlier 2026-10-20 reports that primary exports were missing — that
was withdrawn the same day (10/12 present, then 12/12 once authorized).

### D-2026-10-20-05 — Rehearsal stays on a disposable database; no MariaDB assumption

**Decision:** the import rehearsal runs only against a **disposable** database, and every SQLite→MariaDB
translation is disclosed. No foreign key may be added to `daily_attendance` to make a test pass, because
`004_daily_attendance.sql` declares none.
**Grade:** `VERIFIED` (the harness proves an orphan insert is accepted, matching the migration).
**Open:** F7 — the harness must still be re-run on a real disposable MariaDB.

### D-2026-10-20-06 — The derived event stream is not evidence of employment

**Decision:** employment coverage is measured from the **union of all monthly exports**, never from
`events.csv` (late/early only).
**Grade:** `VERIFIED`.
**Why:** using the derived stream produced three wrong conclusions this session (see
`docs/memory/SESSION_2026-10-20.md` §5). This entry exists to stop the next agent repeating it.

### D-2026-10-20-07 — "2 SSO UUID placeholder records" is not a real finding

**Decision:** no artefact on this machine contains two SSO UUID placeholder records. The claim is
**withdrawn from scope** unless someone produces the source.
**Grade:** `UNVERIFIABLE`. **Not** a blocker. No UUID→person mapping was ever attempted.

### D-2026-10-20-08 — Discrepancy counts must always be quoted with their definition

**Decision:** never quote a single "discrepancy count". Three different measurements exist:
**26** register entries, **25** distinct person-months, **24** observed differences in `monthly_summary.csv`.
**Grade:** `VERIFIED` for 26 and 25; **25-vs-24 is NOT demonstrated**.
**Status:** open. Recorded here so the numbers are not silently collapsed.

### D-2026-10-20-09 — Two identity bases must not be conflated

**Decision:** the 2026-10-19 phase0 import used `dataperson.csv` as its identity master and excluded 19
non-master HIP codes. The 2026-10-20 owner workbook covers **all 54** HIP codes with **0** foreign codes.
`dataperson.csv` is **no longer on disk**, so the two cannot be reconciled mechanically.
**Grade:** `UNVERIFIABLE` (mapping), `VERIFIED` (both code sets).
**Status:** open — the 19-code exclusion is neither confirmed nor revoked. Owner decision required.
