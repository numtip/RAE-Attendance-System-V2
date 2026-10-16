# Session summary — 2026-10-16 parallel tracks (A / B / C)

**Repo:** `G:\ProjectAI\rae-attendance-system-v2` · **Branch:** `feat/slice7-annual-hr-report` (off `081b9db`)
**Status:** `AWAITING REVIEW — nothing merged, nothing executed`
**Labels:** **VERIFIED** (a command was run or the cited file was read) · **REPORTED** · **UNKNOWN**

> ### สรุปผู้บริหาร (Thai abstract)
>
> งานรอบนี้แบ่งเป็น 3 เส้นทางขนานกัน ผลลัพธ์หลัก:
> **A (R-05 รายงานรายปี)** — implement แล้ว gate ผ่านทั้งหมด หลักการสำคัญคือ **ยอดรายปีเป็นได้แค่ค่าจริงหรือ null**
> ถ้าเดือนใดเดือนหนึ่งหายไป ยอดของเมตริกนั้นจะเป็น `null` พร้อมเหตุผล **ไม่ใช่ 0 และไม่ใช่ผลรวมบางส่วน**
> ยืนยันด้วยการสุ่มตรวจ artifact จริง 6 ชุด
> **B (ID-6b/S-02)** — ออกแบบที่เก็บหลักฐานยืนยันตัวตนแล้ว แต่ **ยังไม่แก้ migration** พร้อมข้อค้นพบสำคัญว่า
> digest แบบ keyed **ไม่พอ** ที่จะยืนยันว่า "การค้นหาด้วยเลขบัตรเกิดขึ้นจริง" ต้องเทียบกับแถวของพนักงานคนเดียวกัน
> **C (R1/R3 เคสข้อมูลส่วนบุคคล)** — จัดทำชุดเอกสารสำหรับผู้มีอำนาจตัดสินใจ และ **แก้ข้อผิดพลาดของผมเอง**:
> เลขบัตรรั่วไหลเข้าสู่ `main` ตั้งแต่ `3244553` (2 ต.ค.) ไม่ใช่ `83aaa53` (9 ต.ค.) ตามที่ผมบันทึกไว้
> **และมีข้อบกพร่องร้ายแรงที่พบ**: guard ครึ่งหนึ่งของ ID-7 **ไม่ทำงานจริงบน MariaDB**
>
> **สิ่งที่ต้องขออนุมัติจากเจ้าของ:** (1) migration gate ของ ADR-011/`025` (2) ID-7b (3) R1/R3 (4) R-05b

---

## 1. Track A — R-05 annual HR report ✅

**Deliverable:** [`docs/unified/14_SLICE7_ANNUAL_HR_REPORT.md`](unified/14_SLICE7_ANNUAL_HR_REPORT.md)

| | |
|---|---|
| New files | `annualAttendanceReport.js` (302), `annualReportService.js` (549), `annualReportController.js` (79), `annualReport.test.js` (845), `annualSyntheticFacts.js` (167) |
| Routes | 4 (`report/fiscal-year`, `report/annual-academic`, `export/fiscal-year`, `export/annual-academic`) |
| Gates | lint PASS · **18/18** annual tests · full suite **526 / 516 pass / 0 fail / 10 skipped** · contract-smoke **40 paths** · secret scan 390 · frontend build PASS |

**The core rule — all-or-null totals** (independently verified on real artifacts):

| Scenario | `monthCoverage` | Totals |
|---|---|---|
| all 12 months contributed | `complete: true` | real values (`totalWorkDays 306`, `totalPresent 186`, …) |
| one month excluded | `complete: false`, reason `month_not_derived` | **every total `null`** |

**Honesty gate verified independently:** watermark present **iff** not final — 6/6 scenarios, all A4, **0 gate failures**.

**Reference audit result:** the private reference has **no annual form template** — only annual **close reports**
and per-employee annual documents. R-05 builds the form and copied nothing.

**Two donor precedents honoured** (verified in the reference's own text):
1. months where a code changed owner are not summed together;
2. a field with no source is **not** filled with `0`.

**Honest limitation:** cross-employee code-holder change is **not positively detectable** — the payload says
`crossEmployeeOwnershipDetection: {evaluated: false, reason: …}` rather than pretending. The safety property
still holds (two holders are two `employee_uid`s, so a merge is impossible by construction). Tracked **R-05b**.

## 2. Track B — ID-6b / S-02 identity evidence design ✅

**Deliverable:** 7 files, 1,185 lines — `docs/IDENTITY_EVIDENCE_MODEL.md` (384),
`docs/security/IDENTITY_EVIDENCE_TEST_PLAN.md` (219), `database/proposals/025_identity_evidence.up.sql` (166),
`docs/adr/ADR-011-identity-evidence-storage.md` (153),
`docs/security/IDENTITY_EVIDENCE_THREAT_MODEL.md` (150), `database/proposals/README.md` (68),
`025_identity_evidence.down.sql` (45).

**Key finding — a keyed digest does NOT verify a lookup claim on its own.** It is an **equality oracle**, not
proof of an event. It becomes a genuine *same-binding proof* only when compared for equality against the same
employee's `employee_identifier` `national_id` row under the same key version — needing neither key material
nor plaintext. This is a better answer than the declared-boolean contract I shipped in ID-6.

**Migration `025`** confirmed correct (highest existing is `024`; `018`/`019` reserved by PR #35), and the SQL
lives in `database/proposals/` — deliberately **not** `database/migrations/`, because `migrate.mjs` applies
everything in that folder. **Nothing executed.**

**Residual risks stated, not papered over:** a privileged DB writer can forge consistent evidence; revocation
does not invalidate live sessions; evidence retention is unsolved.

**Notable detail:** it refused to back-fill existing `system:sso` rows because *back-filling would invent
evidence*.

## 3. Track C — privacy incident R1 / R3 ✅

**Deliverable:** 5 files in `docs/incident/` — review (258), notification draft (167), options matrix (221),
runbook (232), decision matrix (148). All PII-screened clean across **plain, dashed, Thai-digit and
full-width** encodings.

**⚠️ It corrected an error of mine.** My incident record said the value reached `main` at `83aaa53`
(2026-10-09). **Wrong.** I re-verified:

| Fact | Result |
|---|---|
| Value reached `origin/main` at | **`3244553`, 2026-10-02** — *"Identity foundation and FaceScan raw ingestion Phase A (#32)"* |
| Is `3244553` main's current tip? | **yes** |
| Is `83aaa53` an ancestor of `origin/main`? | **NO** |
| Value present at `origin/main` now | **YES — still public** |

**Cause (recorded as standing rule 12):** my `git log -S` lookup was scoped to
`backend/tests/nationalIdContract.test.js` — a path that **does not exist on `origin/main`**. Git answered
truthfully about different history and I attributed it to main. A rewrite keyed on the wrong commit would have
left the value public **while appearing to succeed**.

Ref-coverage counts (**read-only git only**): **58 refs** (19 heads / 38 remotes / 1 stash), **83** commits on
main, **133** on HEAD, **151** across all refs.

**Recommendations (all needing authorization):** notify the privacy officer now, hold the individual-facing
draft for legal; **`git filter-repo` on a fresh mirror clone** as the only option that clears public history
while leaving the stashes and `_backups` intact; "make private" is **containment only, never remediation**;
incident stays **OPEN**.

## 4. 🔴 The most important finding: a shipped control is inert in production

Found by Track B, independently verified by me.

| Evidence | Result |
|---|---|
| `enrichment_outcome` in any of the 24 migrations | **never a column** |
| MariaDB `mapRow` | hardcodes `enrichmentOutcome: null` |
| Fixture twin | persists it |

So the outcome half of `enrichmentBlocksApproval` **never fires on MariaDB** and works in every local test —
including the ID-7 **mutation test that killed it with 4 failures**, because that ran against the fixture
repository.

| Guard part | MariaDB |
|---|---|
| `assertKnownSource` (the ID-7 fix) | ✅ works — service-level |
| subject guard (the ID-6 fix) | ✅ works — service-level |
| `confidence ∈ {ambiguous, low}` | ✅ works — real column |
| **blocked `enrichmentOutcome`** | ❌ **inert** |

**Residual risk:** an enrichment link with a blocked *outcome* but `confidence` of `high`/`medium` is
approvable on MariaDB. The confidence check covers the common case, so it is a partial bypass — but real.

**Lesson (rule 6 made concrete):** a mutation test proves a guard bites **on the repository it runs against**;
it cannot prove it bites on the repository the product uses. Tracked **ID-7b / R13**. Needs a migration; a
no-migration stop-gap is to **fail closed on an ABSENT outcome** for enrichment sources instead of treating
silence as success.

## 5. Corrections I made to my own earlier work

1. **Incident introduction commit** — `3244553`, not `83aaa53` (§3). Risk **R10a** added.
2. **ADR numbering was my instruction error.** I told Track B to use `ADR-005`, which the Phase-0 register
   already assigns to *"HIP attendance is independent of SSO"* (register runs to `ADR-010`). Track B **flagged
   the collision** rather than silently colliding. I renumbered it to **`ADR-011`** across all 5 referencing
   files with a resolution note; the register itself was left untouched (another session's untracked doc).
3. **Discarded a contaminated report section.** Track B's "inconsistencies" about `GET /v2/partners`,
   `X-API-Key` and `docs/api.md` **do not exist in this repo** (grep returns nothing). Not propagated
   anywhere. Its *verified* findings were excellent; that section was not.

## 6. Consolidated QA

| Gate | Result |
|---|---|
| `backend` lint | **PASS** |
| Full backend suite | **PASS — 526 tests, 516 pass, 0 fail, 10 skipped** (was 508) |
| Annual suite | **PASS — 18/18** |
| Identity suites (from the prior track) | **PASS — 26 + 6** |
| `contract-smoke` | **PASS — 40 paths** (was 36) |
| Secret scan | **PASS — 390 files** |
| PII screen, all new documents (4 encodings each) | **14/14 clean** |
| Frontend build | **PASS** |
| Independent PDF artifact check | **6/6 honesty gate, 0 failures** |
| Mutation tests (identity guards) | **KILLED — 5 / 4 / 1** — *but see §4: they ran against fixtures only* |

## 7. Governance

Preserved: **2 stashes** · the 4 pre-existing modified files untouched · 19 untracked pre-existing docs ·
**1 worktree** · both private reference repos verifiably unmodified.

Not done: no merge · no PR retarget · no force push · no history rewrite · no migration executed · no SQL
connection · no database write · no production deploy · no real-data import · no notification sent · no secret
created or rotated · no Agent Core call.

## 8. Owner decision gates (nothing proceeds without these)

| Gate | Decision | Blocks |
|---|---|---|
| **G-mig** | Approve `ADR-011` + migration proposal `025` (identity evidence) | Durable, verifiable identity evidence |
| **ID-7b** | Approve the `enrichment_outcome` migration (or the fail-closed stop-gap) | Making the ambiguity guard actually work on MariaDB |
| **R1** | Whether and whom to notify (privacy officer draft ready, **not sent**) | PDPA obligations |
| **R3** | Which history-remediation option; approval for a rewrite + force push | Removing the value from public history |
| **R-05b** | Approve a cross-employee code-lookup method | Positive detection of code-holder change |
| **ID-3 / G7** | Activate real identity integration (needs DPIA + privacy-officer sign-off) | MJU identity kind — still blocked by **ID-5** (the API returns no `personnelID`) |

## 9. Recommended next steps, in order

1. **Triage the open privacy incident (R1/R3).** It is the only item with an active external exposure: a real
   national ID remains retrievable from public history.
2. **Decide ID-7b.** A security control currently implied to work does not work in production; either the
   migration or the fail-closed stop-gap closes it.
3. **Decide the migration gate** (`ADR-011` + `025`) — it is the prerequisite for real identity evidence.
4. **Then** the design gate for real identity integration (ID-3/G7), which also needs the DPIA.
5. Unblocked and independent whenever useful: **R-05b**, the R-03/R-05 frontend surfaces.

## 10. Documents produced this session

| Path | Purpose |
|---|---|
| `docs/unified/14_SLICE7_ANNUAL_HR_REPORT.md` | Track A slice record |
| `docs/IDENTITY_EVIDENCE_MODEL.md` + `docs/adr/ADR-011-*.md` | Track B design |
| `docs/security/IDENTITY_EVIDENCE_{THREAT_MODEL,TEST_PLAN}.md` | Track B security |
| `database/proposals/025_*.sql` + `README.md` | Track B migration **proposal** (not applied) |
| `docs/incident/*.md` (5 files) | Track C review package |
| `docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md` | The incident record (**OPEN**, corrected) |
| `docs/IDENTITY_INTEGRATION_AUDIT.md`, `docs/IDENTITY_MAPPING_CONTRACT.md` | Source audit + contract; findings **F1–F4** |
| `docs/unified/11`–`13_*.md` | R-03 / R-04 / reference-project audit |
