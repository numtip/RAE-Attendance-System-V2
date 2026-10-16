# NEXT_ACTIONS — RAE Attendance System V2

**As of:** 2026-10-15. Ordered so that each item unblocks the next. Every item still needs its own approval,
branch and PR; nothing here authorises a push, merge, migration or deploy.

**Legend:** **VERIFIED** · **REPORTED** · **UNKNOWN**. Size: **S** ≈ hours, **M** ≈ 1–2 days, **L** ≈ 3–5 days.

---

## 0. Every session starts here

> ### 🔁 Consult Jev (Agent Core) once, then work

**Owner instruction (2026-10-16): Jev must be invoked every session.** Enforced by the always-applied rule
[`.cursor/rules/agent-core-jev.mdc`](../.cursor/rules/agent-core-jev.mdc).

```powershell
cd G:\ProjectAI\rae-attendance-system-v2
. .\agent\scripts\use-live-credentials.ps1   # DPAPI store -> this shell only; prints no secret
node agent\scripts\live-smoke.mjs            # ONE call (the per-session budget)
```

Use the result as **advisory input only**. **Neither** the agent's judgement **nor** the agent itself can be
replaced by it:

* If Jev is unreachable (`AGENT_CORE_EDGE_FORBIDDEN`, `PROVIDER_ERROR`, `TIMEOUT`, or no credentials on this
  machine), **say so and continue** on deterministic work. Never block, and never claim a consult that did
  not happen.
* **One call per session** unless the owner asks for more — each call is a real provider call with real cost.
* No PII ever leaves the process (names, national IDs, identifiers, attendance rows, tokens, raw logs).
* A decision is **never** a release approval and never authorises a merge, push, migration, deploy or secret
  change.

## 1. The immediate next milestone

> ### ✅ Attendance report export (R-03) — DELIVERED 2026-10-16

`GET /api/v1/attendance/export/day|month|academic-year/:employeeUid/...?format=pdf|xlsx` (read-only,
scope-enforced). The export derives nothing: it renders the R-02 payload, so an exported total is the same
number the JSON endpoint reports, and `computationStatus` / `isFinal` / `dateCutoff` / rule versions /
population / caveats all travel into the file. Anything that is not final is a **watermarked draft** — 96 pt
`DRAFT` on every PDF page plus a red header on every XLSX sheet. Detail:
[`docs/unified/11_SLICE5_ATTENDANCE_EXPORTS.md`](../unified/11_SLICE5_ATTENDANCE_EXPORTS.md). **No
migration.** Draft PR [#42](https://github.com/numtip/RAE-Attendance-System-V2/pull/42), 8/8 CI green.

> ### ✅ Reconciliation snapshot (R-04) — DELIVERED 2026-10-16 (fixture-verified only)

`GET /api/v1/attendance/reconciliation/day|month|fiscal-year/:employeeUid/...` (read-only). Compares the
canonical stored facts against the verified source records with 18 checks and a deterministic verdict
(`blocked` > `mismatched` > `incomplete` > `matched`). A period with nothing to compare is `incomplete`,
never `matched`; identity ambiguity is `blocked`, never merged. The fiscal year is **Oct–Sep** (BE
`:fiscalYear`), deliberately a different convention from the R-02 academic year (Jun–May). Detail:
[`docs/unified/12_SLICE6_RECONCILIATION.md`](../unified/12_SLICE6_RECONCILIATION.md). **No migration.**

**⚠️ Not verified against any real source.** The reference project
`G:\ProjectAI\attendance-report-generator` **does not exist**, so every snapshot carries
`realSourceVerified: false` plus an explicit note in the payload. See `R-04-B` below.

> ### 🔜 The next milestone

R-05 (annual HR form) reuses the R-03 renderer. Before any wider enablement, clear the blockers in §5.

## 2. Pending Slice 2 follow-ups

**No longer blocked on policy.** On **2026-10-16 the owner approved `AR-0001`** (work `08:30–16:30`, late
after `08:30`, early before `16:30`, Mon–Fri), and **R-01 (monthly summary) is delivered** with provenance
and an honest completeness verdict. So a report has real, traceable numbers to render.

Remaining before a report is *complete*:

1. **`expected_working_days` is working-week-only** until the holiday calendar is imported (S2-D). The
   report raises `HOLIDAY_CALENDAR_EMPTY` whenever such a figure is shown.
2. **Night-shift months report `partial`** until `P-03` defines overnight lateness (S2-B); the report
   raises `NIGHT_SHIFT_LATENESS_WITHHELD`.
3. **`approved_by` is still a session label.** Name the accountable approver before these values are used
   for anything a person is judged on; the report raises `APPROVER_IS_SESSION_LABEL`.
4. **The frontend monthly view now reads the report endpoint** (`R-02-FE`, done 2026-10-16), so the
   verdict is visible in the UI. The legacy `/attendance/monthly` route stays contracted but unused by the
   app.

## 2. Pending Slice 2 follow-ups
| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| **S2-H** | **The known gap: `agent/` is still not linted in CI.** The config now exists (`agent/eslint.config.js`, added `d279bba`) and the folder lints clean, but the `agent-core` CI job runs `npm test` only. | S | — | An `eslint` devDependency **plus a lockfile** exist for the `agent/` package, and CI runs `eslint .` so a lint error fails the build. Must be a pinned install, **not** `npx eslint@latest` |
| S2-A | Obtain owner approval for `AR-0001` (or a corrected policy) with `approved_by`/`approved_at` | S | — | **Values approved 2026-10-16.** Remaining: replace the session label with the accountable person's name |
| S2-B | Define and implement a night-shift lateness rule | M | **P-03** | `overnightLatenessPolicyMissing` disappears only when an approved threshold exists; a golden test pins it |
| S2-C | `monthly_summary` writer derived from `daily_attendance`, same provenance discipline | M | S2-A | Totals reconcile to the daily rows; a month is reproducible from its rule versions |
| S2-D | Holiday calendar import (approved source only) with checksum and owner | M | P-05, P-06 | Import is idempotent; unrelated `department` holidays are not applied |
| S2-E | Employee-scoped schedule onboarding (approved only) | M | P-02 | A pending schedule is reported, never applied; tests cover the boundary |
| S2-F | Retire the donor Attendance Core proxy routes behind a documented contract change | M | — | The contract change is documented and announced; no consumer breaks silently |
| S2-G | Verify the live Gateway decision path with one consenting credential (read-only smoke) | S | credentials | One `NEXT_ACTION` and one `QA_DISPOSITION` decision; the secret is never printed |
| S2-I | Leave-remark classification as an opt-in, owner-approved token set | M | **P-07** | Tokens come from an approved rule version, not a hardcoded list; false-positive cases tested |

## 3. Attendance reports — the next milestone, broken down

| ID | Task | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|
| ~~R-00~~ | ~~Owner approves a rule version~~ | — | — | **DONE 2026-10-16.** `AR-0001` approved for 2026. `approved_by` still needs a real name. |
| ~~R-01~~ | ~~`monthly_summary` derived writer~~ | — | — | **DONE — PR [#39](https://github.com/numtip/RAE-Attendance-System-V2/pull/39)**, migration `024`. Completeness verdict, provenance, idempotent, no phantom months. |
| R-02 | Report endpoints for one employee: day / month / academic year, scope-enforced | M | R-01 | **DONE 2026-10-16** (no migration; not committed). 401 anonymous, 403 cross-scope; every report names its rule version, date cutoff and population, and surfaces `computationStatus` + `isFinal` instead of hiding a partial month. `docs/unified/10_SLICE4_ATTENDANCE_REPORTS.md` |
| R-02-FE | Wire `frontend/src/views/AttendanceMonthlyView.vue` to `/attendance/report/month/...` so the UI shows the completeness verdict | S | R-02 | **DONE 2026-10-16** — verdict rendered before the figures; a never-derived month shows no figures instead of zeros. Verified in review/fixture mode. |
| R-03 | Export layer (XLSX with Thai fonts, PDF, annual form) | L | R-02 | **DONE 2026-10-16** (no migration). PDF + XLSX, day/month/academic-year, scope-enforced, `format` required with no default, non-final exports watermarked `DRAFT` / `ข้อมูลยังไม่สมบูรณ์` across every page and sheet. Zero-dependency XLSX (`exceljs` rejected); only `pdfkit` added. `docs/unified/11_SLICE5_ATTENDANCE_EXPORTS.md` |
| R-04 | Read-only reconciliation snapshot: daily / month / **fiscal year (Oct–Sep)** | M | R-02 | **DONE 2026-10-16** (no migration). 18 checks; deterministic `blocked` > `mismatched` > `incomplete` > `matched`; nothing-to-compare is `incomplete` never `matched`; identity ambiguity `blocked` never merged; never joins by name; `pristine: true` with an immutability test. Fiscal year is Oct–Sep (BE `:fiscalYear`), separate from the R-02 academic year (Jun–May). `docs/unified/12_SLICE6_RECONCILIATION.md` |
| R-04-B | Re-scope: the reference project **exists** (audited 2026-10-16) | S | — | Was "source missing"; it is now **"source exists, integration not done"**. See `R-04-C` |
| **R-04-C** | Integrate the FY2569 reconciliation evidence as a fixture — **aggregate counts only, no names or codes** | M | R-04, audit §5 | **DONE 2026-10-16.** `backend/tests/fixtures/fy2569Aggregates.js` (12 monthly aggregates + totals 1,600/24/11/8 + 26 discrepancies as 3 classification counts) and `reconciliationFiscalEvidence.test.js` (sums, fiscal alignment via the existing `fiscalYearPeriod`, and a **non-vacuous PII guard**). **Transcription, not integration** — `realSourceVerified` stays `false`. `docs/unified/12_SLICE6_RECONCILIATION.md` §5.5 |
| ~~R-04-T~~ | ~~Pin a snapshot-level `mismatched` verdict with a scenario test~~ | — | — | **DONE 2026-10-16** — `reconciliation.test.js` asserts it from real fixture data, with the reason recorded |

## 5a. Identity integration — DESIGN GATE (not activated)

| ID | Task | Note |
|---|---|---|
| **ID-1** | Identity source audit of `mju-person-enrich` | **DONE 2026-10-16** — `docs/IDENTITY_INTEGRATION_AUDIT.md`. It is **corroboration-only**, not an identity authority: name-based fuzzy lookup, ambiguity fails open, 303 plaintext national IDs at rest on a non-git disk |
| **ID-2** | Identity mapping architecture & data contract | **DONE 2026-10-16** — `docs/IDENTITY_MAPPING_CONTRACT.md`; migration proposal only, **nothing executed** |
| **ID-3** | 🛑 **OWNER DECISION — activate real identity integration?** | **BLOCKED at the design gate.** Needs approval of contract §8/§9 **and a completed DPIA + privacy-officer sign-off** (the requirement is documented; no completed DPIA was found). **No live ID-card processing** |
| **ID-4** | **`MJU_PERSON_ENRICHMENT_KB.md` does not exist** (verified; only a dangling reference in the Blueprint) — yet it is named as the "personal-data local-only policy" | Provide it or drop the reference |
| **ID-8** | **MJU API governance obligations are undocumented in this repo** — found at `G:\AI\docs\integrations\MJU_API_GOVERNANCE_POLICY.md`: DPIA + privacy-officer sign-off, multi-stakeholder approval, MFA for Admin/DataOwner, Secret-Manager token rotation, quarterly access review, per-endpoint owner + OpenAPI spec | Cite them in the contract (done) and satisfy them before any integration |
| **ID-5** | **The MJU Person API returns no `personnelID`** (0/308), so it **cannot populate the MJU identity kind**, which expects `personnel_id` from `mju_person_api` | Decide: find an endpoint that returns one, or re-scope the MJU kind |
| **ID-6** | Harden `createCandidate` (audit finding **F1**): enforce the `EMAIL_LIKE` + `ac` guard at the link layer, not only in the SSO adapter | **DONE 2026-10-16.** Guard moved into `domain/identityLink.js` and shared by **both** creation paths; it also rejects malformed, non-finite, over-long (255 char) and whitespace-padded subjects. Mutation-tested: removing it fails 5 tests. `backend/tests/identityLinkHardening.test.js` |
| **ID-7** | Make `ENRICHMENT_SOURCES` a checked, tested constant (audit finding **F2**) | **DONE 2026-10-16.** Frozen `IDENTITY_LINK_SOURCES` allowlist; an unknown source is refused at creation (`400 IDENTITY_SOURCE_UNKNOWN`). This closed a real bypass, not just a hygiene gap: an invented source string used to escape the ambiguity guard entirely. Drift guarded in both directions by `identityLinkSourcePolicy.test.js`. Mutation-tested: removing it fails 4 tests |
| **ID-6b** | **Residual (S-02):** store the approval EVIDENCE TYPE as its own field, not only `approvedBy: 'system:sso'` | The SSO path now requires a *declared* matched national-ID lookup (`403 IDENTITY_EVIDENCE_REQUIRED`), but the declaration cannot be independently re-verified in the link layer and is not a stored column. Needs a **migration**, therefore needs approval |
| R-04-F | Owner confirmation of the fiscal-year window (Oct–Sep) as a policy value | S | — | Reporting convention today, same treatment as P-05/P-06 |
| R-03-FE | Export controls in the day and academic-year views | S | R-02-FE pattern | `AttendanceDailyView.vue` renders raw `AttendanceRecord[]`, so it needs the report endpoint first |
| R-04 | Reconciliation test: recompute a closed month and match a frozen synthetic snapshot | M | R-02 | Recalculation of a past month reproduces the stored numbers exactly |

## 4. Slice 1 follow-ups still open

| ID | Task | Size | Depends on |
|---|---|---|---|
| S1-C | Admin CSV ingestion route: authenticated, admin-only, dry-run preview, no partial import | M | DT-06 |
| S1-D | Verify the HIP export header contract and freeze the column map (currently a candidate) | M | **D-04** |
| S1-E | Effective-dating write API (`setValidity`) + assignment window editing, with audit | M | — |
| S1-F | Load the authoritative employee master into `employees` + `employee_assignment` | L | **D-01** |
| S1-G | Frontend: assignment history on the profile page | M | S1-E |

## 5. Carried-over blockers from the handoff (not started)

`D-01` employee-master source · `D-02` legacy DB recovery · `DT-03` the pre-`013` ledger gap ·
`D-06` MJU `ac` semantics · `S-01`–`S-13` security items · `O-01` PR-stack drift (`#30 → #33 → #34/#35`).

## 6. Documentation and hygiene

| ID | Task | Size | Note |
|---|---|---|---|
| DOC-1 | Refresh `docs/SESSION_HANDOFF.md` with the Slice 1/2 status | S | **Needs approval** — it carries another session's uncommitted WIP (`HY-2`) |
| DOC-2 | Decide the fate of the stale branch `feat/attendance-core-service` (2 local-only, superseded commits) | S | **Needs approval** (`HY-1`); evidence in `PROJECT_STATE.md` §4a. Do not delete unilaterally |
| DOC-3 | Fold `docs/memory/*` into the Phase-1 document set once the stack merges | S | The memory set now lives on the tip branch; `docs/daily-closeout-20261015` (#38) holds an **older snapshot** — reconcile when merging so one set wins |
| DOC-4 | The Jev rule is always-applied, but it cannot run on a machine without the DPAPI store (CI, another workstation). Decide whether to keep that as "report and continue" or provision a machine-wide path | S | **Needs owner decision** |

## 7. Standing rules discovered the hard way (do not relearn these)

1. **Never format a stored date with `String(value).slice(0, 10)`.** MariaDB returns a `Date` for
   `DATE`/`DATETIME` (the pool sets `timezone: 'Z'`); the fixture twins return strings. Use
   `wallDateOnly()` / `splitWallDateTime()`. **This has broken two consecutive slices**, and only the
   `backend-mariadb` CI job catches it. (`docs/unified/08_…` §4)
2. **Never compare stored timestamps as strings.** A naive `'2031-11-03 23:00:00'` and an ISO
   `'2026-10-16T04:16:45.000Z'` do not order lexicographically — the separator and the year digits decide.
   Normalise to epoch millis first (`toEpochMillis` in `monthlySummaryService`). This produced a false
   `stale` in Slice 3. Same family as rule 1.
3. **An `await` is part of an authorization check.** `assertCanReadEmployee(...)` without `await` does not
   gate the response — the request proceeds and the rejection becomes an unhandled rejection. Slice 3
   shipped this in four places; only the negative-path test caught it.
4. **A month row aggregates DAY verdicts; it does not re-judge them.** Seeding a `calculated` day and
   expecting a `pending_policy` month is testing a fiction.
5. **Bound test fixtures.** An open-ended approved rule (no `effectiveTo`) covers every later date and
   leaks into other suites, because CI runs test files in parallel against one database.
6. **The fixture/MariaDB twin pattern hides type divergence.** Local green is necessary but **not
   sufficient** for anything that reads a column.
7. **Passing tests do not prove an external contract.** 46 green agent tests asserted the adapter's *own*
   shape while three defects made the real gateway unreachable: a `choice` question needs **`criteria` with
   at least two options**, the **Cloudflare Access** headers must be sent in addition to the project token,
   and the `decision_type` enum must match the gateway exactly. **Test the remote schema, not just your own
   object.** (`docs/AGENT_CORE_LIVE_USAGE.md`)
8. **A retry wrapper must not swallow a specific error code.** Collapsing an edge refusal and a rejected
   token into a generic "unavailable" hid the cause for three debugging rounds. Only timeouts, network
   faults and 5xx are retryable.
10. **A guard must prove it is not vacuous.** Two checks written in this session looked correct and verified
    nothing: one "scanned" 0 files (a wrong root), one matched 0 literals (a regex that missed ternary and
    default-parameter forms). Both were caught only because a non-vacuity assertion was written alongside
    them. Assert the coverage (files read, matches found) *and* mutation-test the guard.
11. **A guard that is scoped is a guard that can be walked around.** `enrichmentBlocksApproval` only applies
    to known enrichment sources, so an invented source string escaped it entirely. When a control is scoped
    by an input value, that input needs its own closed allowlist — and the allowlist needs a test that fails
    when a new value appears without being registered.
9. **Call Jev once per session** (see §0). It is advisory: never block on it, never claim a consult you did
   not make, and never let it authorise a privileged action.
7. **Never rename an applied migration.** The ledger keys on the full filename with no checksum.
8. **An unapproved rule must never produce a number.** If a feature needs a policy value, the answer is to
   ask the owner, not to add a default.
9. **Call `git.exe`, not the `git` shell function**, on this Windows host; write commit messages to a temp
   file and use `git commit -F`. Never `git add -A`.

