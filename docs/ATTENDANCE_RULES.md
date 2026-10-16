# Attendance rules (versioned) — contract

**Status:** implemented in Slice 2; month derivation added in Slice 3. **`AR-0001` was approved by the
project owner on 2026-10-16** (work `08:30–16:30`, late after `08:30`, early before `16:30`, working week
Mon–Fri), so 2026 dates compute. Its `approved_by` is a **session label, not a person** — naming the
accountable approver is still required before production use. A 2027 date reports `pending_policy` because
the only rule covering it (`AR-0002`) is **not** approved.

Companion documents: [`unified/07_SLICE2_ATTENDANCE_ENGINE.md`](unified/07_SLICE2_ATTENDANCE_ENGINE.md),
[`ATTENDANCE_CORE.md`](ATTENDANCE_CORE.md) (the donor we no longer proxy to for calculation),
[`unified/08_MIGRATION_DEPENDENCY_GRAPH.md`](unified/08_MIGRATION_DEPENDENCY_GRAPH.md).

## 1. Why a version, and not a config file

The rule values (work hours, lateness/early thresholds, the working week) previously existed only in the
donor project's `config/settings.yaml` and in Python defaults. Nothing was versioned, effective-dated or
approved, so:

* a past period could not be recomputed reproducibly — the numbers depended on whatever the config said
  *today*;
* no stored result could name the rule that produced it, which the blueprint forbids (§12: every number
  needs source, cutoff, filter, population and rule version).

`attendance_rule_version` (migration `022`) stores the policy **as data**, with an effective window and an
approval state, so a result can always name its rule.

## 2. The honesty gate (the central rule)

**An unapproved rule is never used, and its absence is never filled with a default.**

| Situation | `computation_status` | `status` | Numeric result |
|---|---|---|---|
| An `approved` rule is effective on the date, scans can be paired | `calculated` | `present` / `late` | produced |
| An `approved` rule is effective, working day, no scans, no leave | `no_data` | `absent` | zero — a real absence, which the rule confirms |
| An `approved` rule is effective, but the scans cannot be interpreted | `insufficient_data` | `pending` | **withheld** |
| No `approved` rule covers the date | `pending_policy` | `pending` (or `leave`/`holiday`, which are rule-independent facts) | **withheld** |
| An error while computing that day | `failed` | — | **withheld** |

Consequences worth stating plainly:

* A `draft` or `pending_approval` rule is discoverable (`findEffectiveRuleVersionAnyStatus`) purely so the
  API and CLI can tell an operator *why* a day is pending. It is never selected for a calculation.
* The shipped fixture demonstrates both sides: `AR-0001` is **approved** for 2026, and `AR-0002` is
  **pending_approval** for 2027, so a 2026 date computes while a 2027 date reports `pending_policy`.
* `daily_attendance.status` gained a `pending` value in migration `023` **specifically** so that "we have the
  facts but cannot judge this day" is representable. Without it the only options would be `present` or
  `absent`, both of which assert something unproven.
* `late_minutes`, `early_minutes` and `work_duration` are `0` in every non-`calculated` case. They are not
  estimates.

## 3. The rules, and where each value comes from

| Field | Meaning | Provenance |
|---|---|---|
| `work_start` / `work_end` | The nominal working window | Donor `settings.yaml` (`08:30`/`16:30`). **Not owner-approved.** |
| `late_after` | A check-in strictly later than this is late; equal is on time | Donor default `= work_start` |
| `early_before` | A check-out strictly earlier than this is an early departure | Donor default `= work_end` |
| `work_days_json` | ISO-8601 day numbers (1=Mon .. 7=Sun) | **V2 addition.** The donor had no working week; it relied on the input rows. `NULL` means "not specified" — the engine then uses Mon–Fri **and records `workDaysDefaulted: true`**. |
| `overnight_shift` | Treat a check-out earlier than the check-in as the next day | **V2 addition** (donor gap) |
| `max_shift_span_minutes` | Refuse a span longer than this instead of recording it | **V2 addition** |
| `ignore_holidays` | `1` = an approved holiday is excluded; `0` = the rule explicitly says holidays are worked | Donor `ignore_holidays`, but the *calendar* is now an engine input |
| `leave_types_json` / `leave_aliases_json` / `business_statuses_json` | Policy token lists, versioned with the rule | Donor token lists preserved verbatim; **not owner-approved** |

**Day precedence:** approved holiday → non-working day → verified leave → (no rule → `pending_policy`) →
scans. A holiday and a non-working day are recorded factually, never judged.

## 4. Leave: facts, not remarks

Lateness and leave come from different places, deliberately.

* **Leave is a verified fact.** A row in `employee_leave` counts as leave only when `status = 'approved'`
  **and** `match_status = 'matched'` **and** the date falls inside `start_date..end_date` (inclusive).
  Anything else is a proposal and leaves the absence standing.
* The donor classified leave by parsing Thai remark text (`ป่วย`, `พักผ่อน`, …). That path is **not** wired
  into the calculation. Remark classification remains a donor capability, and porting it needs an owner
  decision because substring matching (e.g. the alias `ลา`) produces false positives. Until then, a
  remark-only hint does not create leave.
* A leave type outside the four stored values (`sick`, `personal`, `vacation`, `other`) is **recorded as
  `null` and reported** in `reconciliation_json.leaveTypeUnmapped`. It is never coerced into a wrong type.
* If two verified leave rows cover the same day, the day is still leave, and
  `reconciliationJson.leaveFactAmbiguous` plus the candidate count are set.

## 5. Scans, identity and historical ownership

* Scans are aggregated **by the `employee_uid` stamped at ingest time** through the effective-dated
  mapping (Slice 1). The engine **never** re-resolves identity. This is what makes a historical
  recalculation keep the ownership that was true when the scan was imported, even after an employee code
  has been reused by someone else.
* A scan attributed to another employee, or to nobody, is **excluded and counted**
  (`foreignEventsExcluded`, `unattributedEventCount`). It is never re-attributed.
* Duplicate scans (same second *and* same check type) are collapsed and counted
  (`duplicateScanCount`). They do not become a second pair.
* Scans on the day after are used as the departure of a night shift **only** when overnight is enabled and
  the scan is before noon; scans after noon belong to that day's own row. This keeps exactly one row per
  shift. A shift that *starts* the previous evening is evaluated on the previous day's row.

## 6. Unresolved policies (must be decided by the owner, **not** by an agent)

| # | Open policy question | Current behaviour while unresolved |
|---|---|---|
| P-01 | Are the work hours `08:30–16:30` correct for each employee type? | **Owner-approved 2026-10-16** for the whole of 2026 via `AR-0001`. Still open: whether other employee types need a different rule, and who the accountable approver is. |
| P-02 | Is the working week Mon–Fri for everyone, and do any units differ? | Approved as Mon–Fri for 2026. A schedule can override per employee; a missing value falls back to Mon–Fri **and is flagged**. |
| P-03 | How is lateness defined for a **night shift**? No approved source defines an overnight-relative threshold. | The span is recorded; lateness and early departure are **withheld** and `overnightLatenessPolicyMissing` is set. |
| P-04 | Are `late_after`/`early_before` grace periods, and is there a rounding rule? | Exact comparison, boundary inclusive. |
| P-05 | Which holiday scope applies (national / university / department)? | The table supports all three; only `approved` rows count. The calendar is empty. |
| P-06 | Is a `department` holiday inherited by sub-units? | Exact `org_unit_code` match only; no hierarchy is assumed. |
| P-07 | Do Thai remark tokens (`ป่วย`, `พักผ่อน`, …) still create leave? | No. Verified `employee_leave` rows only (§4). |
| P-08 | Which source is authoritative when a schedule and a rule disagree? | The approved **schedule** wins for the employee, and its code is stored as provenance. |

To approve rule `AR-0001` an operator must supply `approvedBy` and `approvedAt`; the database enforces this
with `chk_rule_version_approval`, so an untraceable approval cannot be written.

## 7. Recalculation

* `POST /api/v1/attendance/recalculate` (manager/admin). Deterministic and idempotent.
* One row per `(employee_uid, date)` — enforced by `uk_daily_attendance_employee_date` (migration `023`).
  A rerun updates in place and **replaces** the source-event links inside the same transaction.
* The same stored inputs always produce the same numbers; `calculated_at` and `updated_at` are the only
  fields that move.
* With no `employeeUid`, only employees **that have scans in the range** are rebuilt.
* One bad day is recorded as `failed` with its reason and does not abort the run.

## 8. Month derivation (Slice 3)

A month is **derived from the stored daily rows** — never recomputed from scans — so a month total is
always traceable to the days that produced it.

**The completeness verdict.** A month carries `computation_status`:

| Status | Meaning |
|---|---|
| `no_data` | no stored daily rows at all |
| `pending_policy` | at least one day is `pending_policy` (an approved rule is missing), so recalculating cannot fix the month |
| `partial` | at least one day is `insufficient_data` or `failed` |
| `calculated` | every stored day was judged |

**A month is never `calculated` while any day inside it is unjudged.** `pending_days` reports the size of
the hole.

A day whose *day-level* status is `no_data` is a **complete judgement** — the rule said working day and no
scan arrived, so the person was absent — and does **not** make the month partial. Treating an absence as
unknown would make every normal month look incomplete.

**Two different "work day" numbers, on purpose:**

* `total_work_days` — days the rule classified as workdays in the stored rows.
* `expected_working_days` — what the approved calendar says should have been worked (working week minus
  approved holidays; `ignoreHolidays = 0` means holidays are worked).

They differ when rows are missing, and that difference is the **reconciliation signal**.
`expected_working_days` is **NULL, never 0**, when it cannot be derived, and `derivation_notes` says why
(`no_approved_rule`, `working_week_not_specified`, `calendar not supplied`).

**No phantom months.** A month with no daily rows and no existing row is not written — an empty row would
read as a real month of zeros. It is reported in the run summary instead.

**Staleness is judged by value, not by timestamp.** `explain` compares the derived result fields (counts,
minutes, hours, completeness, rule versions) because `calculated_at` always moves on a rerun, and a
derivation and a daily recalculation can share a millisecond.

**Authorization.** Deriving writes derived data, so it requires manager/admin, and the organization-wide
form additionally requires a resolved **broad** data scope — role alone is not enough.

Full contract: [`unified/09_SLICE3_MONTHLY_SUMMARY.md`](unified/09_SLICE3_MONTHLY_SUMMARY.md).
