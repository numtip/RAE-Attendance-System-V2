# ADR-014 — the attendance rule engine lives in this repository

**Status:** `APPROVED DIRECTION` (owner, 2026-10-29, decision **D-10**) — the *wiring* of the engine into the
request path is **not** approved by this ADR and needs its own review.
**Supersedes:** nothing. **Related:** ADR-012 (identity), `docs/ATTENDANCE_CORE.md`, `docs/memory/DECISIONS.md`
(D-E / `AR-0001`), `docs/PR_RECONCILIATION_2026-10-29.md` (D-10).

## Context

Two implementations of one policy existed, and neither could be trusted alone:

* `backend/src/services/attendanceCoreClient.js` is an HTTP proxy to a separate service. It is **unreachable in
  every buildable environment**: compose passes no `ATTENDANCE_CORE_URL`, `config/index.js` defaults to `''`,
  and a call fails closed with 503. No CI job, no route, no frontend reference sets it. Nothing validates it at
  startup.
* The approved rule values (`AR-0001`: work 08:30–16:30, late after 08:30, early before 16:30, Mon–Fri, 2026
  calendar year) live in **no code in this repository** — only in `docs/memory/DECISIONS.md` (D-E) and in the
  out-of-repo engine.
* Seven pull requests (#36, #37, #39, #41, #42, #43, #46) cannot be sensibly rebased until this is decided.
* Migrations `022`/`023`/`024` already landed on `main` and describe the *engine's* schema
  (`attendance_rule_version`, approval gate, `source_kind DEFAULT 'derived_from_daily_attendance'`) with **zero
  code referencing them**.

## Decision

The rule engine is **in-repo**, pure, and versioned by rule version — not an out-of-repo HTTP dependency.

1. Rules are code (`backend/src/domain/attendanceRuleEngine.js`), keyed by an explicit rule version
   (`AR-0001`), with the policy constants visible in one frozen object.
2. A date whose year has no approved rule set is **refused** (`RULE_YEAR_NOT_APPROVED`), not silently evaluated
   under the previous year's rules. `AR-0002` (2027) is not approved.
3. There is **no `ABSENT` status**. The approved rules describe what a scan means; they say nothing about a
   missing scan. A day with no scan is `no_data` and a human decides. (Standing rule: "ไม่มี ABSENT".)
4. The engine is **pure**: `HH:MM` wall-clock strings, minutes-of-day comparisons, no `Date` arithmetic, no
   timezone conversion, no database. That is what makes the seven slices testable without a container.

## Consequences, including the uncomfortable ones

* **Nothing is wired yet.** This ADR lands an unwired module plus its boundary tests; `attendanceComputeService`
  and `attendanceCoreClient` are untouched, so behaviour is unchanged and the proxy path still 503s where it
  always did. A reader must not mistake the presence of the engine for a replacement that has happened.
* **Deleting the proxy is a separate, reviewable change** and must land *with* the engine's adoption, not
  before: `attendanceCoreClient`, `attendanceComputeService`, the controller, routes, its test and the
  `.env.example` block go together, or a half-state ships.
* **Parity is unproven against real data.** No test yet recomputes a closed FY2569 month with this engine and
  compares it to the stored numbers. Until that exists, the engine is a specification, not a verified
  replacement. (#43 is the PR that can do it.)
* **Absence policy is still an HR decision**, not an engineering default.
* **A rule change is a code change with a version bump**, reviewed like any other; the rule version is carried
  on the result so a recomputation can say *which* rules produced it.

## Alternatives rejected

* **Keep the proxy (D-10 Option A).** Needs the same missing input *plus* a second runtime to deploy, monitor
  and secure, and it cannot run in CI at all, so the seven slices stay untestable. Rejected by the owner.
* **Hybrid "keep the proxy just in case".** Two sources of truth for a late-arrival rule is precisely the
  failure mode: a Thai university office cannot reconcile two different definitions of "late".
* **Put the rules in configuration instead of code.** The values are approved policy with a version and an
  approval record; configuration drifts without review, and `AR-0001` must be identifiable in an audit.
