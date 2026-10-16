# DECISIONS — RAE Attendance System V2

Decisions taken while building Slice 1 and Slice 2 (2026-10-15), with the reasoning that makes them
reviewable. Owner-level decisions that are still **open** are listed separately in §3 — nothing there was
silently resolved by an agent.

**Label legend:** **VERIFIED** · **REPORTED** · **UNKNOWN** (as used throughout `docs/unified/`).

---

## 1. Decisions that were approved by the owner

| # | Decision | Consequence |
|---|---|---|
| D-A | **Slice 1 isolation: in-place feature branch, no git worktree.** `AGENTS.md` forbids new worktrees while the blueprint and the initial task text suggested one (conflict X-01). | One worktree only; conflict X-01 stays open at owner level. Recorded in `docs/unified/06` §0. |
| D-B | **Slice 1 scope = schema + contracts + ingestion foundation only** — no attendance rule math. | Rule math became Slice 2 instead of being crammed into Slice 1. |
| D-C | **Push the slice branches and open Draft PRs; no merge.** | PRs #36 and #37 are Draft; `main` untouched. |
| D-D | **Do not edit `docs/SESSION_HANDOFF.md`** (it carries another session's uncommitted WIP). | Slice status lives in `docs/unified/06`/`07`/`09` and `docs/memory/`; updating the handoff is pending. |
| D-E | **Approve the candidate attendance rule values** (2026-10-16): work `08:30–16:30`, late after `08:30`, early before `16:30`, working week Mon–Fri, for the 2026 calendar year. | `AR-0001` became `approved`; 2026 dates now compute. `AR-0002` (2027, `pending_approval`) keeps the honesty gate demonstrable. **`approved_by` is recorded as a session label, not a person** — the DB `CHECK` requires an approver to exist, but naming the accountable individual is still required before production use. |
| D-F | **Jev (Agent Core) must be consulted once at the start of every session**, and it must be wired into this project for real — not left as an unused adapter (2026-10-16). | Worked end to end: the adapter now reaches the live gateway. Enforced by the always-applied rule `.cursor/rules/agent-core-jev.mdc`. |
| D-G | **The Jev consult is ADVISORY, and `report-and-continue` on failure — it must never block work.** One call per session unless the owner asks for more. | Credentials live in a per-user DPAPI store, so CI and other machines cannot consult Jev. Blocking there would stop all work for no safety gain. Budget: each call is a real provider call with real cost. |

## 2. Engineering decisions made during Slice 1 / Slice 2

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E1 | **Effective-dating via an interval table, not a history/audit table.** `employee_assignment` holds one row per validity interval. | Lets a past period be recomputed with the data true then. The versioned-rule rationale is the same. | `06_SLICE1…` §2.2 |
| E2 | **Overlap and employee-code-conflict rejection is enforced in a repository transaction with `FOR UPDATE`**, not only in the service. | A service-only check can be bypassed by a concurrent writer. | `06_SLICE1…` §2.2 |
| E3 | **One validity window per identifier value; a value never moves between employees.** | The security-critical `UNIQUE(id_type, id_value)` and the migration-017 namespace triggers were left untouched rather than weakened to support re-assignment. Deliberate limitation. | `06_SLICE1…` §2.3 |
| E4 | **A closed/open validity window uses two nullable DATE columns with `NULL` = "no bound", and `onDate = null` = "do not filter".** | Preserves the exact pre-`020` behaviour for callers that do not care about history (notably the SSO national-ID lookup). | `06_SLICE1…` §2.3 |
| E5 | **CSV ingestion delegates to the existing `ingestCheckinoutBatch`** instead of reimplementing validation/dedup. | Keeps one owner for validation, dedup and idempotency; the adapter only adds file parsing, a header contract and provenance. | `06_SLICE1…` §1.1 |
| E6 | **The CSV header map is a CANDIDATE, overridable contract.** | The real HIP export headers are unverified (`HIP_ID_FIELD_UNVERIFIED`). Inventing a confirmed-looking contract would be a fabrication. | `06_SLICE1…` §5.3 |
| E7 | **Migration numbering `020`/`021`/`022`/`023`, skipping `018`/`019`.** | Draft PR #35 already claims `018`/`019`, and the ledger keys on the filename, so this keeps both branches applicable in either merge order. | `08_MIGRATION_DEPENDENCY_GRAPH.md` §3 |
| E8 | **Every new migration is `information_schema`-guarded and idempotent, with a rollback file.** | DDL auto-commits and the ledger has no checksum, so a partial failure can only be repaired by re-running the same file. | `08_…` §1 |
| E9 | **Versioned rules as DATA (`attendance_rule_version`), not a config file.** | A stored number must be able to name the rule that produced it, and a past period must be reproducible. | `07_SLICE2…` §2.1 |
| E10 | **The honesty gate: an unapproved rule produces `pending_policy` with zero minutes, never an estimate.** `late_minutes`/`early_minutes`/`work_duration` are non-zero only when `computation_status = 'calculated'`. | An attention system must not assert an absence or a lateness it cannot prove. | `ATTENDANCE_RULES.md` §2 |
| E11 | **`status` gains a `pending` value (migration `023`).** | Without it the only options for "facts known, judgement impossible" would be `present` or `absent` — both assertions. This is an additive ENUM widening. | `07_SLICE2…` §2.2 |
| E12 | **Night-shift lateness is WITHHELD, not invented.** The span is recorded; lateness and early departure are flagged `overnightLatenessPolicyMissing`. | No approved source defines an overnight-relative threshold. This is open policy question **P-03**. | `ATTENDANCE_RULES.md` §6 |
| E13 | **Leave comes from verified `employee_leave` rows, not from Thai remark text.** | The donor's substring matcher (alias `ลา`) produces false positives. Porting it needs an owner decision (**P-07**). | `ATTENDANCE_RULES.md` §4 |
| E14 | **The engine never re-resolves identity.** It aggregates `attendance_events` by the `employee_uid` stamped at ingest. | Preserves historical ownership after an employee code is reused; a scan is never silently re-attributed. | `07_SLICE2…` §2.2 |
| E15 | **Idempotency via `UNIQUE(employee_uid, date)` plus delete-then-reinsert of the source-event links in one transaction.** | A recalculation legitimately references a different event set, so the links must be replaceable — and a failed link write must not leave a row claiming provenance it lacks. | `07_SLICE2…` §2.2 |
| E16 | **The clock is passed into the calculation (`calculatedAt`), never read inside it.** | Determinism: the same stored inputs reproduce identical numbers, which is what makes a historical report defensible. | `07_SLICE2…` §2.2 |
| E17 | **The Express runtime does NOT import `agent/`; the advisory is container-injected and optional.** | `agent/` is documented as agent-only, and an Agent Core outage must never block or alter a core calculation. | `07_SLICE2…` §3 |
| E18 | **Agent Core integration is restricted to `POST /v1/decision`.** `TASK_ROUTE` is unavailable (scope `route` is not granted); `QA_DISPOSITION` is used only as a `decision_type`, because the guard is per-route. | Verified from the `agent-core` source, not assumed, and encoded as data (`UNAVAILABLE_ENDPOINTS`) with a test asserting every call goes to `/v1/decision`. | `07_SLICE2…` §1.2 |
| E19 | **Sanitization and the sensitive-content assertion live inside `decide()`, the single decision path.** | Enforcing them only in the CLI let `employeeUid`/`nationalId` reach Agent Core verbatim. A boundary that can be bypassed is not a boundary. | `07_SLICE2…` §4.1 |
| E20 | **`agent/eslint.config.js` added, but lint was NOT wired into CI.** | The folder had no config at all. Enforcing lint needs an `eslint` devDependency **and a lockfile** for that package; reaching for `npx eslint@latest` would put an unpinned registry fetch in CI. Deferred as **S2-H** rather than faked. | `07_SLICE2…` §6 item 7 |
| E21 | **`explain.stale` compares decision fields, not timestamps.** | `calculatedAt` necessarily differs on a fresh run, so the original comparison was always `true` and meaningless. | `07_SLICE2…` §4.1 |
| E22 | **Two verification passes were commissioned and their findings fixed before push.** Six defects in total, two of them blockers. | In both slices the verifier found something the author's tests had missed. | `07_SLICE2…` §4.1 |

### Slice 3 decisions (2026-10-16)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E23 | **A month carries a completeness verdict** (`calculated` / `partial` / `pending_policy` / `no_data`), and a month is never `calculated` while any day inside it is unjudged. | A month total that silently averages over days nobody could judge looks authoritative and is worse than no total. | `09_SLICE3…` §2.1 |
| E24 | **A day-level `no_data` (absent) is a COMPLETE judgement and does not make the month partial.** | Conflating "absent" with "unknown" would make every normal month look incomplete. | `09_SLICE3…` §2.1 |
| E25 | **`expected_working_days` is separate from `total_work_days`**, and is `NULL` (never `0`) when it cannot be derived, with the reason recorded. | `total_work_days` is what the rows show; `expected_working_days` is what the approved calendar says. Their difference is the reconciliation signal. A `0` would read as "nobody was expected to work". | `09_SLICE3…` §2.2 |
| E26 | **A month with no daily rows and no existing row is not written.** An existing row is refreshed. | An empty row would read as a real month of zeros. | `09_SLICE3…` §2.3 |
| E27 | **A month is DERIVED from the stored daily rows, never recomputed from scans.** | A month total must be traceable to the days that produced it, and the daily engine owns the day judgement. | `09_SLICE3…` §2.5 |
| E28 | **Staleness is judged by VALUE (the derived result fields), not by `calculated_at`.** | A timestamp always moves on a rerun, so a timestamp comparison is always "stale" and means nothing; and two operations can share a millisecond, so a strict `>` can miss a real change. | `09_SLICE3…` §2.4 |
| E29 | **Monthly derivation requires manager/admin, and the organization-wide form requires a resolved BROAD data scope.** | Deriving writes derived data; and role alone must never widen data scope — the same rule Slice 2 had to be fixed to enforce. | `09_SLICE3…` §3.4 |
| E30 | **Timestamps are normalised to epoch millis before any comparison.** | A naive `'2031-11-03 23:00:00'` and an ISO `'2026-10-16T04:16:45.000Z'` do not order lexicographically, which produced a false `stale`. | `09_SLICE3…` §4 |
| E31 | **Fixture/MariaDB test rules are BOUNDED with an explicit `effectiveTo`.** | An open-ended approved rule covers every later date and leaks into other suites, because CI runs test files in parallel against one database. | `NEXT_ACTIONS.md` §7 rule 5 |

### Agent Core / Jev decisions (2026-10-16)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E32 | **Fix the adapter rather than replace it.** The three defects are payload/transport bugs, not an architecture problem. | The boundary design (one endpoint, sanitized payload, advisory-only, fail-closed) was already right; only the wire contract was wrong. | `AGENT_CORE_LIVE_USAGE.md` §1 |
| E33 | **`buildQuestion()` validates LOCALLY and supplies default `criteria` per decision type.** | The gateway rejects a `choice` without ≥ 2 criteria with an opaque 400. Failing locally costs nothing and names the field. | `AGENT_CORE_LIVE_USAGE.md` §1 |
| E34 | **`SUPPORTED_DECISION_TYPES` mirrors the gateway enum exactly (8 values).** `TASK_ROUTE_PROPOSAL` was removed because it does not exist upstream. | Local validation must not accept what the gateway rejects; and the distinction that matters is preserved — a `*_ROUTE` value is valid in the `/v1/decision` **body** but the routing **endpoints** still need the `route` scope. | `AGENT_CORE_LIVE_USAGE.md` §2 |
| E35 | **A non-JSON 403 is reported as `AGENT_CORE_EDGE_FORBIDDEN`, and specific error codes are never collapsed into a generic "unavailable".** | The edge refuses before the origin sees the request; the generic code sent debugging in the wrong direction for three rounds. Only timeouts, network faults and 5xx are retryable. | `AGENT_CORE_LIVE_USAGE.md` §6 |
| E36 | **The credential loader sets process-scoped environment variables and is dot-sourced.** | Keeps the secret out of the repo, out of files and out of logs, and out of child processes' environment once the shell closes. | `agent/scripts/use-live-credentials.ps1` |
| E37 | **`live-smoke.mjs` is the only script that touches the real gateway, makes exactly one call, and refuses to run without credentials.** | Bounds cost and blast radius, and makes the live path explicit rather than incidental. | `agent/scripts/live-smoke.mjs` |
| E38 | **Jev stays OFF the attendance request path.** The Express runtime still does not import `agent/`. | An Agent Core outage must not block or alter a calculation; a test injects a failing advisory and proves the stored number is unchanged. | `07_SLICE2…` §3 |

### Report decisions — R-02 (2026-10-16)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E39 | **A report is READ-ONLY: it never calculates a day and never derives a month.** Deriving stays behind the manager/admin-only monthly-summary route. | A report that recomputed would be a second source of truth for the same period, and a read must not be able to change the data it describes. | `10_SLICE4…` §2.2 |
| E40 | **`isFinal` is defined per scope, and a day-level `no_data` IS final while a month-level `no_data` is NOT.** | The daily engine only yields `no_data` when an approved rule confirmed a working day and no scan arrived — "absent" is a finding (E24), not a gap. A month-level `no_data` means the days were never derived, so a month of zeros must never read as a month of attendance (E26). Collapsing the two would either over-claim or make every normal month look incomplete. | `10_SLICE4…` §1 |
| E41 | **A Thai academic year is 1 June – 31 May, it is a REPORTING convention (not a policy value), and every response names the window it used.** | A report must not leave its period to be assumed. `:year` is the Gregorian year the academic year starts; months that have not started yet are excluded from the completeness verdict because a month that has not happened cannot be missing data. | `10_SLICE4…` §1.2 |
| E42 | **The known limitations travel WITH the numbers as `report.caveats`** (`HOLIDAY_CALENDAR_EMPTY`, `NIGHT_SHIFT_LATENESS_WITHHELD`, `APPROVER_IS_SESSION_LABEL`), derived rather than assumed. | R2, R8 and P-03 all make a figure narrower than it looks. A caveat that is only in a document will not be read next to the number; one attached to the response will be. Deriving them means recording the accountable approver or importing the holiday calendar removes the caveat automatically. | `10_SLICE4…` §1.1 |

### Export decisions — R-03 (2026-10-16)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E43 | **The export layer derives NOTHING.** Report data comes only from `attendanceReportService`; the sole extra read is the employee display record. | A second derivation path would let a file and the API disagree about the same month, and the file is the version people circulate. | `11_SLICE5…` §1 |
| E44 | **A non-final report is exported as a watermarked draft in BOTH formats** — 96 pt `DRAFT` on every PDF page, plus a red DRAFT row and print header on every XLSX sheet. | A PDF or spreadsheet is easy to forward and hard to recall, so the R-02 completeness verdict has to survive being printed, not just being displayed. | `11_SLICE5…` §1, §4.2 |
| E45 | **`exceljs` rejected; the XLSX writer is hand-written over `node:zlib`.** `pdfkit` is the only new dependency. | `exceljs` would add ~186 packages plus deprecated `glob@7`/`fstream`/`uuid@8` and an unresolved moderate advisory whose only fix is a breaking downgrade. The needed output is one sheet type and a fixed part set. | `11_SLICE5…` §3 |
| E46 | **The Sarabun font is bundled** under `src/assets/fonts/` with its OFL text and SHA-256 hashes; a missing font throws `EXPORT_FONT_MISSING`. | A PDF cannot render Thai without an embedded font, and a silent fallback would render Thai as empty boxes — a failure that looks like success. | `11_SLICE5…` §3, font README |
| E47 | **`format` is required with no default.** | A default would silently choose an artifact for the caller. An unknown format (including a traversal attempt) is a 400, never a file. | `11_SLICE5…` §2.2 |
| E48 | **Export endpoints answer with a file, not the JSON envelope, and `contract-smoke` validates the difference** (content type, non-empty body, `Content-Length` agreement, `%PDF`/`PK` magic). | The published contract had to describe a binary response, and a smoke test that only checked for `success: true` would have passed on a broken download. | `11_SLICE5…` §5 |
| E49 | **Review mode disables export instead of faking a file.** | Consistency with E20: report what is real. A fabricated artifact in the static demo would misrepresent the product. | `11_SLICE5…` §2.3 |

### R-03: accepted limitation (2026-10-16)

* **PDF Thai text extraction is not byte-exact.** Words containing `ำ` (U+0E33) can extract decomposed
  (`ทำงาน` → `ทำางาน`), because pdfkit applies GSUB and its ToUnicode CMap maps the reordered glyph back to
  both codepoints. Visual output, numbers and dates are all correct; this affects search and copy-paste only.
  Accepted and documented rather than worked around, because fixing it means rewriting the CMap.

### Reconciliation decisions — R-04 (2026-10-16)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E50 | **Reconciliation derives nothing and writes nothing.** It reuses `attendanceReportService` for report totals and audits the stored rows; every snapshot carries `pristine: true`, and an immutability test deep-snapshots every store before and after. | An audit that changes what it audits is worthless, and a second computation path would let the audit and the data disagree. | `12_SLICE6…` §1.1, §5.2 |
| E51 | **"Nothing to compare" is `incomplete`, never `matched`**, and the precedence is `blocked > mismatched > incomplete > matched`. | Same trap E26 guards on the monthly side: a period with no rows is not agreement. | `12_SLICE6…` §1.2 |
| E52 | **`mismatched` is only raised between commensurable values.** Period aggregates compare only months that were actually derived, and report `incomplete` when months are missing. | Summing 1 derived month against 12 months produced a false `mismatched`. Comparing incommensurable totals is the same class of error as R-01's phantom month. Found by this slice's own test. | `12_SLICE6…` §1.2, §4 |
| E53 | **Identity ambiguity is `blocked`, and arbitration is never attempted.** Two effective assignments on one date, or a conflicting identifier, is flagged; reconciliation never merges, never joins by name, and never reassigns a record. | Requirement 5. A silent merge would silently move someone's attendance to another person. | `12_SLICE6…` §1.2, §5.3 |
| E54 | **The fiscal year (Oct–Sep, BE `:fiscalYear`) is a separate convention from the R-02 academic year (Jun–May)**, in its own module, with a test asserting the windows differ. | Two different Thai year conventions exist; conflating them would silently reconcile the wrong twelve months. The window is named in every response. | `12_SLICE6…` §1.3 |
| E55 | **`realSourceVerified: false` and its note live INSIDE the payload**, not only in a document, and a test pins them. | With the external reference missing, a consumer must not be able to read a `matched` snapshot and believe the original HIP/MJU source was verified. | `12_SLICE6…` §3 |
| E56 | **`snapshotHash` excludes clock-derived fields (`asOf`, `cutoff`) and itself**, and says so at the hash site. | A hash that moves every run makes the determinism test meaningless. Documenting which fields are excluded keeps it honest rather than convenient. | `12_SLICE6…` §2.3 |

## 2.5 Reference-project boundary (E57)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E57 | **The sibling `numtip/Attendance-Report` project may only be consumed by V2 at AGGREGATE level.** No names, no employee codes, no rosters, no entry logs, no screenshots. | That project is **private** and holds **real employee names** in 13 tracked files (no national IDs were found); **V2 is public**. The donor already applies the same discipline to Agent Core ("aggregate counts and verification flags only"), so this is consistency, not a new restriction. | `13_REFERENCE_PROJECT_AUDIT.md` §4, §7 |

## 2.6 Transcribed-evidence and identity-source decisions (2026-10-16)

| # | Decision | Why | Recorded at |
|---|---|---|---|
| E58 | **Transcribed external evidence is a FIXTURE, not an integration, and `realSourceVerified` stays `false`.** | Hand-copied aggregate counts can exercise the code but prove nothing about the original source. Calling that "verified" would be the exact over-claim the honesty gate exists to prevent. | `12_SLICE6…` §5.5 |
| E59 | **`mju-person-enrich` is a CORROBORATION-ONLY source; it must never establish an identity.** It may supply `citizenID` equality against V2's own HMAC digest, offline. | Its only lookup key is a **name**, the `/filter/` endpoint is **fuzzy** (7/308 returned names differ from the query), ambiguity **fails open** to `data[0]` (a real 2-record case had two different ids), and it holds 303 plaintext national IDs at rest on a **non-git** disk where `.gitignore` is inert. | `IDENTITY_INTEGRATION_AUDIT.md` §2, §3, §8 |
| E60 | **The MJU Person API cannot populate the MJU identity kind** — it returns no `personnelID` (0/308), while `identityKind` requires `personnel_id` with `source_system='mju_person_api'`. | The obvious integration plan is therefore not merely risky but **impossible as specified**. The design must go via `citizenID` equality after the employee is already resolved. | `IDENTITY_INTEGRATION_AUDIT.md` §1.1, §6; `IDENTITY_MAPPING_CONTRACT.md` §3 |
| E61 | **Real identity integration stays at a DESIGN GATE.** No live ID-card processing, no identity import, no migration, no key creation. | Requires owner approval of the contract plus a written data-protection basis for receiving citizen IDs, which does not exist yet. | `IDENTITY_MAPPING_CONTRACT.md` §9 |
| E62 | **The identity-link layer must not rely on a single caller for its guards.** `createCandidate` accepts an email-shaped subject; only the SSO adapter rejects one today. | Defence in depth: a future ingestion path would bypass the guard entirely. Recorded as finding F1, with hardening proposed rather than assumed. | `IDENTITY_INTEGRATION_AUDIT.md` §F1 |

## 3. OPEN owner decisions (do NOT treat as engineering defaults)

> ### ✅ R-04-B RESOLVED (partly) — the reference project EXISTS
>
> `G:\ProjectAI\attendance-report-generator` was **absent** at ~13:53 and ~14:06 on 2026-10-16 and **present**
> at ~14:24. It has been audited: [`docs/unified/13_REFERENCE_PROJECT_AUDIT.md`](../unified/13_REFERENCE_PROJECT_AUDIT.md).
>
> It is a **sibling project** (`numtip/Attendance-Report`, **private**) in the same GitHub family as this repo
> and `numtip/attendance-core`, and it is the **origin of the `AR-0001` values** this repo approved
> (`config/settings.yaml`: `work_start 08:30`, `work_end 16:30`, `late_after 08:30`, `early_before 16:30`) —
> and of the FY2569 evidence R-04 wanted.
>
> So the blocker is no longer availability but **integration** (`R-04-C`). R-04 still reads nothing external,
> so `realSourceVerified: false` remains correct; only the *reason* changes.
>
> **⚠️ Governance:** that repo is **private and holds real employee names** in 13 tracked files (no national
> IDs were found). **This repo is public.** Any integration must consume **aggregate counts only** — never
> rosters, names, codes, entry logs or screenshots.

### 3a. Attendance policy — the engine is blocked on these

| # | Question | Current behaviour while unresolved |
|---|---|---|
| P-01 | Are the work hours `08:30–16:30` correct per employee type? | **Owner-approved 2026-10-16 for 2026 (`AR-0001`).** Still open: other employee types, and who the accountable approver is. |
| P-02 | Is the working week Mon–Fri for everyone, and do any units differ? | Approved as Mon–Fri for 2026; schedule-overridable per employee, and a missing value falls back to Mon–Fri **and is flagged** |
| **P-03** | **How is lateness defined for a night shift?** | Span recorded; lateness/early departure **withheld** and flagged |
| P-04 | Are `late_after`/`early_before` grace periods, with any rounding rule? | Exact comparison, boundary inclusive |
| P-05 | Which holiday scope applies (national / university / department)? | All three supported; only `approved` rows count; calendar is empty |
| P-06 | Is a `department` holiday inherited by sub-units? | Exact `org_unit_code` match only; no hierarchy assumed |
| P-07 | Do Thai remark tokens (`ป่วย`, `พักผ่อน`, …) still create leave? | No — verified `employee_leave` rows only |
| P-08 | Which wins when an approved schedule and a rule disagree? | The schedule wins for that employee, and its code is stored as provenance |

Approving a rule requires `approved_by` **and** `approved_at`; a database `CHECK` enforces it, so an
untraceable approval cannot be written.

### 3b. Platform and data decisions still open

| # | Decision | Status |
|---|---|---|
| D-01 | Which populated source is the authoritative employee master? | **open** — `employee_assignment` has no source of truth loaded |
| D-02 | Recover the legacy `attendance_db`, or declare it out of scope? | **open** |
| D-04 | Is CSV `Facescan Code` really the HIP `facescan_id`? | **open** — gate stays closed |
| D-05 | Authoritative attendance source per day | **open** |
| D-06 | What is `ac` (lifetime, single-use, binding, signing)? | **open** — MJU IT has not answered |
| D-07 | Live host gate values (`SSO_ENABLED`, `DATA_SOURCE`) | **UNKNOWN** — never read |
| D-09 | Which host runs the unified production runtime | **open** |
| D-10 | Who approves HR / executive data scope | **open** |
| X-01 | Blueprint worktrees vs `AGENTS.md` "no worktrees" | **open** — resolved in practice by D-A (no worktree), rule unchanged |
| HY-1 | Delete the stale local branch `feat/attendance-core-service` (2 local-only, superseded commits)? | **open** — evidence in `PROJECT_STATE.md` §4a; needs explicit approval |
| HY-2 | Refresh `docs/SESSION_HANDOFF.md` with the Slice 1/2 status? | **open** — it carries another session's WIP |
| **R-04-F** | **Is the reconciliation "fiscal year" the Thai government Oct–Sep year?** | **open** — implemented as `1 Oct – 30 Sep` (BE `:fiscalYear`), named in every response, and deliberately separate from the R-02 academic year (Jun–May). Needs owner confirmation before it is treated as a policy value (same treatment as P-05/P-06). |
| **R-04-B** | Provide `G:\ProjectAI\attendance-report-generator`, or declare FY2569 real-source reconciliation out of scope? | **RESOLVED 2026-10-16** — the project exists and is audited (`docs/unified/13_REFERENCE_PROJECT_AUDIT.md`). What remains is **integration** (`R-04-C`) |
| **R-04-C** | Integrate FY2569 evidence as aggregate-only reconciliation fixtures? | **DONE 2026-10-16** — 12 monthly aggregates + totals + 26 discrepancies as 3 counts, no names or codes; PII guard is tested and non-vacuous. Transcribed, not integrated, so `realSourceVerified` stays `false` |
| **ID-3** | 🛑 Activate **real** identity integration (Person API ingestion, effective-dated links, migration §8)? | **open — BLOCKED at the design gate.** Needs owner approval of `IDENTITY_MAPPING_CONTRACT.md` §8/§9 **and a completed DPIA + privacy-officer sign-off** (the requirement is documented in an MJU API governance policy found on this machine; **no completed DPIA was found**). No live ID-card processing until then |
| **ID-4** | `MJU_PERSON_ENRICHMENT_KB.md` does not exist — provide it, or drop the Blueprint reference? | **open** — it is cited as the "personal-data local-only policy", so its absence leaves that policy undocumented |
| **ID-8** | The MJU API governance obligations (DPIA, multi-stakeholder approval, MFA, Secret-Manager rotation, quarterly access review, per-endpoint owner + OpenAPI spec) were undocumented in this repo | **documented 2026-10-16** in `IDENTITY_MAPPING_CONTRACT.md` §6.1 and `IDENTITY_INTEGRATION_AUDIT.md` §0.2 — they must be **satisfied**, not just cited, before integration |

## 4. Decisions explicitly NOT taken (and why)

* **Retiring the donor `attendance-core` Python service.** Its `/attendance/evaluate-*` proxy routes still
  exist. It is now redundant for daily calculation, but removing it changes a published API contract, so it
  is a separate, documented decision (backlog S2-F).
* **Porting the Thai leave-remark classifier.** Needs **P-07** first.
* **Writing to `daily_attendance` from a rule the owner has not approved**, or auto-promoting `AR-0001`.
* **Applying any migration to a real database.** The live ledger is pre-`013`; no apply order exists.
* **Deleting or editing any stash, backup or pre-existing WIP.**
