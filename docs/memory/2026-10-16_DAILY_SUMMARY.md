# Daily summary — 2026-10-16 (Asia/Bangkok)

**Scope of the day:** deliver backlog item **R-01** (a `monthly_summary` writer derived from
`daily_attendance`, with provenance and a completeness verdict) and record the **owner's approval of the
attendance rule**. No production operation of any kind.

Continues [`2026-10-15_DAILY_SUMMARY.md`](2026-10-15_DAILY_SUMMARY.md).

**Labels:** **VERIFIED** = observed in this session · **REPORTED** · **UNKNOWN**.

## 1. The owner decision

`AR-0001` was `pending_approval`, so the engine produced no numbers. **The owner approved the candidate
values** (work `08:30–16:30`, late after `08:30`, early before `16:30`, working week Mon–Fri) for the 2026
calendar year.

Recorded honestly:

* `AR-0001` → `approved`, effective `2026-01-01`..`2026-12-31`, `approvedBy: 'owner:session-2026-10-16'`.
* **`approvedBy` is a session label, NOT a person.** The database `CHECK` requires an approver to be present
  so an untraceable approval cannot be written, but **naming the accountable individual is still required
  before production use** of these values. Flagged in the fixture, in the rule's `notes`, in
  `docs/ATTENDANCE_RULES.md` and in `docs/unified/09`.
* A second rule **`AR-0002`** (`pending_approval`, from 2027-01-01) was added as the unapproved successor so
  the honesty gate stays **demonstrable end to end**: a 2026 date computes; a 2027 date reports
  `pending_policy`.
* Four Slice 2 assertions changed as a consequence, because they asserted the fixture shipped a
  pending-only rule. They now assert the approved path plus the 2027 gate. **No production code was changed
  to make them pass.**

## 2. What shipped

| Item | Branch | Tip SHA | PR | State |
|---|---|---|---|---|
| R-01 — monthly summary derived from daily attendance | `feat/slice3-monthly-summary` | `08b55ba` | [#39](https://github.com/numtip/RAE-Attendance-System-V2/pull/39) | OPEN, **Draft**, 8/8 CI green (VERIFIED) |

Migration **`024`** plus rollback. Deliverables: migration domain module, repository twins, service, five
routes, 3 test files, `docs/unified/09_SLICE3_MONTHLY_SUMMARY.md`, and updates to `docs/API_CONTRACT.md`
and `docs/ATTENDANCE_RULES.md`.

### The completeness contract (the point of the slice)

A month carries `computation_status`: `no_data` / `pending_policy` / `partial` / `calculated`.
**A month is never `calculated` while any day inside it is unjudged.** A day whose *day-level* status is
`no_data` (absent) is a **complete judgement** and does **not** make the month partial — conflating
"absent" with "unknown" would make every normal month look incomplete.

`expected_working_days` (what the approved calendar says should have been worked) is separate from
`total_work_days` (what the stored rows show). Their difference is the reconciliation signal. It is
**`NULL`, never `0`**, when it cannot be derived, and `derivation_notes` says why.

A month with no daily rows and no existing row is **not written** — an empty row would read as a real month
of zeros.

## 3. Defects found before push

Four defects, all caught by running tests rather than by reading code. Two were mine and two were the
product's.

| # | Severity | Defect | Found by |
|---|---|---|---|
| 1 | **blocker (security)** | The Slice 3 service called `assertCanReadEmployee(...)` **without `await`** in four places, so the authorization check did not gate the response — a forbidden read returned data. | the fixture integration test's **negative** case |
| 2 | important (authz) | `recalculateMonth` never called `assertCanRecalculate`, so a plain employee could trigger writes. | the API scope test |
| 3 | important | Staleness compared `calculated_at` timestamps, which always move on a rerun and can collide within a millisecond. | the staleness test |
| 4 | important | **Timestamps compared as strings.** A naive `'2031-11-03 23:00:00'` and an ISO `'2026-10-16T04:16:45.000Z'` do not order lexicographically, so a freshly derived month was reported stale. | **CI**, after a diagnostic assertion named the field |

Defect 4 is the same family as the `Date`/string hazard that broke Slices 1 and 2, and it took **three** CI
attempts to pin down. What finally worked was making the failure self-describing (the assertion now prints
`staleReasons` plus both rows) rather than reasoning from the symptom. Recorded as standing rule 2 in
`NEXT_ACTIONS.md` §6.

Also recorded: four of the author's own test **expectations** were wrong (two scanless days not one; early
minutes 60 not 30; `missingWorkingDays` 17 not 16; and an existing day being *updated* rather than added),
and a fifth was wrong at the design level — seeding a `calculated` day and expecting a `pending_policy`
month, when the month **aggregates** day verdicts rather than re-judging them.

## 4. QA evidence (all VERIFIED)

| Check | Result |
|---|---|
| Backend lint | clean |
| Backend suite | **380 tests, 370 pass, 0 fail, 10 skipped** |
| Monthly domain · Slice 3 integration | 23/23 · 14/14 |
| `contract:smoke` | **27** paths (was 22) |
| Agent suite · frontend build · secret scan | 46/46 · pass · pass |
| CI PR #39 | **8/8 green**, including `backend-mariadb` (applies `001`–`024`) |

**Not verified:** migration `024` was never applied to a database on this host (no Docker/MariaDB). As with
Slices 1–2, `backend-mariadb` is the DDL verification and the `Date`/string parity check. Never applied to a
populated database; no apply order proposed. No live Agent Core call (no credentials locally).

## 5. Conversation cost of the CI cycle (worth not repeating)

Three failed CI runs on the same test. The first two were caused by an incomplete diagnosis: I attributed
the failure to cross-test rule leakage (a real problem, and fixing it was necessary) when the primary cause
was a wrong test premise. **The lesson: make a failing assertion print the data it compared before changing
any code.** Doing that took one run and ended the guessing.

## 6. Jev (Agent Core) — now working, verified live

The adapter existed but **could not have reached the service**. Three defects, each invisible to the 46
passing tests because those tests asserted the adapter's own shape and never the gateway's schema:

1. a `choice` question was sent **without `criteria`** (the gateway requires ≥ 2) → **HTTP 400 every time**;
2. the **Cloudflare Access** service-token headers were never sent → the **edge refused with an HTML 403**
   before the origin saw it, reported misleadingly as `MALFORMED_RESPONSE`;
3. `SUPPORTED_DECISION_TYPES` listed `TASK_ROUTE_PROPOSAL`, which **does not exist** in the gateway enum.

All three are fixed, plus a fourth found while fixing them: the retry wrapper collapsed specific error codes
into a generic `AGENT_CORE_UNAVAILABLE`, which hid the cause.

**Verified live (real calls, synthetic context only):**

```
QA_DISPOSITION  -> EXECUTE,  confidence 0.90, fallback false
NEXT_ACTION     -> FALLBACK, confidence 0.22, fallback true
```

The second is the designed fail-safe, not a failure: thin context yields low confidence and
`defer_to_human`.

**Scope (verified from the agent-core source):** `decision` only → `POST /v1/decision` is the only callable
endpoint. `TASK_ROUTE` cannot be called as an endpoint (needs the `route` scope) though it is a valid
`decision_type` in the body.

Delivered in PR [#40](https://github.com/numtip/RAE-Attendance-System-V2/pull/40): 16 new offline contract
tests, `agent/scripts/use-live-credentials.ps1`, `agent/scripts/live-smoke.mjs`, and
`docs/AGENT_CORE_LIVE_USAGE.md`.

## 7. A new standing instruction: consult Jev every session

Per the owner (2026-10-16), **Jev must be invoked once at the start of every session.** It is enforced by
the always-applied rule `.cursor/rules/agent-core-jev.mdc`:

```powershell
. .\agent\scripts\use-live-credentials.ps1
node agent\scripts\live-smoke.mjs            # ONE call; the per-session budget
```

**It is advisory and must never block work.** If Jev is unreachable — no DPAPI store on this machine, an
edge refusal, a rejected token — the session **says so and continues** on deterministic work. A decision
never authorises a merge, push, migration, deploy or secret change, and no PII is ever sent.

## 9. Deliberate non-actions

* Nothing merged, retargeted, force-pushed, reset or cleaned. **PRs #36/#37/#38/#39 stay Draft.**
* No production contact: no SSH, no deploy, no migration on real data, no config or secret change.
* Pre-existing WIP preserved (18 entries, 2 stashes) — re-counted and confirmed unchanged.
* `docs/SESSION_HANDOFF.md` still **not** modified (it carries another session's uncommitted WIP).

## 10. Next

**Individual attendance reports (R-02)** — no longer blocked on policy approval. See
[`NEXT_ACTIONS.md`](NEXT_ACTIONS.md) §0 for the three caveats a report must respect (empty holiday calendar,
night-shift months are `partial`, and `approved_by` still needs a real name). A report must **surface**
`computation_status` rather than render a `partial` month as if it were final.
