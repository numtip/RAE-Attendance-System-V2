# 13 — Reference project audit: `G:\ProjectAI\attendance-report-generator`

**Date:** 2026-10-16 (Asia/Bangkok) · **Audited:** `G:\ProjectAI\attendance-report-generator`
**Remote:** `numtip/Attendance-Report` (private) · **Method:** read-only inspection. **No file in the audited
project was created, modified, deleted or committed.**
**Labels:** **VERIFIED** (observed by a command today) · **REPORTED** (asserted in the project's own docs) · **UNKNOWN**

> ### สรุปผู้บริหาร (Thai abstract)
>
> โครงการนี้ **ไม่ใช่โปรเจกต์แปลกหน้า** แต่เป็น **พี่น้องร่วมตระกูลเดียวกับ V2** ภายใต้บัญชี GitHub
> `numtip` เดียวกัน และเป็น **แหล่งที่มาของค่า `AR-0001` ที่ V2 อนุมัติ** (08:30–16:30, สายหลัง 08:30,
> กลับก่อน 16:30) รวมถึงเป็น **เจ้าของข้อมูลหลักฐาน FY2569 ที่ R-04 ต้องการ** ซึ่งตอนนี้ **มีอยู่จริง**
> (ก่อนหน้านี้ตรวจแล้วไม่พบ)
>
> ประเด็นสำคัญที่สุด: โครงการนี้เป็น **repo เดียวในตระกูลที่เป็น private** และ **มีชื่อพนักงานจริงอยู่ในไฟล์ที่
> ถูก track 13 ไฟล์** (ไม่พบเลขบัตรประชาชน 13 หลักเลย) ขณะที่ **V2 เป็น public** — จึง **ห้ามนำชื่อหรือ
> ข้อมูลระดับบุคคลจากโครงการนี้เข้ามาใน V2** ใช้ได้เฉพาะ **ตัวเลขสรุป (aggregate)** เท่านั้น

---

## 1. What the project is

A **Python 3.10+ pipeline** that turns *HP Premium Time* CSV exports into monthly Thai attendance reports and
the official monthly form, plus a QA layer.

| Property | Value (**VERIFIED** unless noted) |
|---|---|
| Local path | `G:\ProjectAI\attendance-report-generator` |
| Remote | `https://github.com/numtip/Attendance-Report.git` — **PRIVATE** |
| Branch / HEAD | `main` @ `658a0ea` — in sync with `origin/main` (no ahead/behind) |
| History | 9 commits; 153 tracked files; 24 MB on disk |
| Language / tooling | Python, `pytest` (**53 tests collected**), `openpyxl`, `PyYAML`, `pandas` |
| Layout | `src/{ingestion,parser,engine,excel,validation,reporting}`, `templates/`, `tests/`, `docs/`, `site/` |
| Shared conventions | Has its own `AGENTS.md` and `.ai/{jev.yaml,policies.yaml}` — the same Agent Core platform conventions V2 uses |
| Local state | **3 modified tracked files + 26 untracked files** (23 collapsed `git status --porcelain` entries, because untracked directories collapse to one line). **1 stash.** Uncommitted WIP — **do not touch.** |

The project's own README advertises a GitHub Pages site at `numtip.github.io/Attendance-Report/`, publishing
**only** the static `site/` folder, explicitly to keep workbooks and personnel files out of the public artifact.

## 2. The three-repo family

Both this project and V2 are siblings under the same GitHub owner, and neither is the root:

| # | Repository | Local path | Visibility | Role |
|---|---|---|---|---|
| 1 | `numtip/attendance-core` | `G:\ProjectAI\attendance-core` | **public** | **Canonical domain rules.** Python library, tag `v0.1.0`. `engine.py`, `policy.py`, `leave_parser.py`. Docs: architecture, data contract, identity mapping, integration plan |
| 2 | `numtip/Attendance-Report` | `G:\ProjectAI\attendance-report-generator` | **private** | **This audit.** Monthly report + official-form pipeline. Consumes #1 (`requirements.txt` → `-e ../attendance-core`; CI pins `git+…@v0.1.0`) |
| 3 | `numtip/RAE-Attendance-System-V2` | `G:\ProjectAI\rae-attendance-system-v2` | **public** | **V2.** The Node/Express rewrite. Ports the day-evaluation semantics of #1 |

`numtip/agent-core` (public) is a fourth, orthogonal project: the shared Agent Core / Jev control plane used by
both this project and V2.

The generator states its own dependency discipline explicitly, and V2 should adopt the same wording
(`docs/ATTENDANCE_CORE.md`):

> *"Do not duplicate architecture documents in this repo — link to `attendance-core/docs` only."*

## 3. How it relates to V2 — the lineage, point by point

This is the substance of the audit: **the generator is the origin of several V2 values that V2 currently
attributes more loosely.**

| V2 artefact | Origin in this project / the family | Status |
|---|---|---|
| **`AR-0001` rule values** — work `08:30–16:30`, late after `08:30`, early before `16:30`, `ignoreHolidays: true` | `config/settings.yaml` of **this** project: `work_start "08:30"`, `work_end "16:30"`, `late_after "08:30"`, `early_before "16:30"`, `ignore_holidays: true`. `attendance-core/policy.py` carries the same `08:30`/`16:30` defaults | **VERIFIED — exact match** |
| **Boundary semantics** (08:30 / 16:30 exactly = NOT late / NOT early) | `attendance-core/engine.py` uses strict comparisons: `clock_in_time > policy.late_after`, `clock_out_time < policy.early_before`. The generator's own README states *"เวลา 08:30 และ 16:30 พอดีไม่นับ"*. V2's `dailyAttendanceCalculation.js` also uses strict `>` / `<` | **VERIFIED — all three agree** |
| **Leave from Thai remark text** (`ป่วย`, `พักผ่อน`, …) and its false positives (`ลา` alias) | `config/settings.yaml`: `leave_types`, `leave_type_aliases` (incl. `ลา → อื่นๆ`), `business_statuses`. This is precisely the matcher V2 **rejected** in decision **E13** and deferred as policy question **P-07** | **VERIFIED** — the donor behaviour V2 declined to port |
| **Thai month names + Buddhist Era year** | `config/settings.yaml`: `thai_months`, `thai_buddhist_year: true` | **VERIFIED** |
| **Executive report column contract** (11 columns: `ที่`, `ชื่อพนักงาน`, `หน่วยงาน`, `วันทำงาน(วัน)`, …) | `config/settings.yaml` → `columns` | **REPORTED** — a candidate contract for V2's R-03/R-05 exports |
| **Monthly official form engine** (28 form checks) | `src/monthly_form.py`, `src/excel/monthly_form_writer.py`, `templates/monthly_attendance_form_template.xlsx` | **VERIFIED** — the closest existing analogue of V2's R-05 |
| **FY2569 reconciliation evidence** | `CodexWorker/prepared/**` — 67 files (rosters, entry logs, plans, reviews, screenshots), plus `_build_meta.json` with a SHA-256 per file | **VERIFIED — see §5. This is R-04's missing input** |
| **Agent Core / Jev adapter** | `CodexWorker/scripts/agent_core_client.mjs`, `jev_qa_gate.mjs`, `CodexWorker/docs/agent-core-jev-integration.md` — uses `POST /v1/decision` with `QA_DISPOSITION`, i.e. **the same contract as V2** | **VERIFIED** |
| Shared platform conventions | `AGENTS.md` + `.ai/{jev.yaml,policies.yaml}` with identical wording to V2's | **VERIFIED** |

### 3.1 What V2 already knows vs. what it did not

* V2 **does** document `attendance-core` as the donor: `docs/unified/07_SLICE2_ATTENDANCE_ENGINE.md` §"the donor's
  rule semantics are ported from `attendance-core` `engine.py` / `policy.py`", and
  `backend/src/domain/dailyAttendanceCalculation.js` says the same in its header.
* V2 had **no prior reference at all** to `attendance-report-generator` — the only mentions are the
  "does not exist" notes added in R-03/R-04 today (§6 corrects those).

## 4. Data and PII assessment

The generator handles real personnel data. The governance question that matters is **whether any of it can
reach V2, which is public.**

**Containment is good:**

* This is the **only private repo in the family**, consistent with holding real data.
* Its `.gitignore` excludes every data class that matters: `*.csv` (with `!tests/fixtures/*.csv`), `input/logs/`,
  `output/`, `logs/`, and the manual workbooks (`6june.xlsx`, `*june*.xlsx`, `total2026-3.xlsx`, …).
  **VERIFIED** by `git check-ignore` on each.
* **Zero 13-digit national-ID matches in all 153 tracked files** — scanned for `\b\d{13}\b`.
* `docs/dataperson.csv` and `docs/total2026-3.xlsx` exist locally but are **ignored**, not tracked.

**But real personal data IS committed.** 13 tracked files contain an employee code immediately followed by a
Thai personal name. Reporting **paths and counts only, no values**:

| Tracked file | code+name hits |
|---|---|
| `CodexWorker/prepared/README.md` | 13 |
| `CodexWorker/prepared/september2569-review.md` | 5 |
| `CodexWorker/prepared/_build_meta.json` | 4 |
| `CodexWorker/prepared/july2569-review.md`, `june2569-review.md`, `CodexWorker/scripts/build_prepared.py` | 4 each |
| `CodexWorker/prepared/may2569-review.md`, `reports/2026-10-06-codexworker-summary.md` | 3 each |
| 6 further `*-review.md` / `_build_meta.json` files | 1–2 each |

No national ID, no 13-digit number, no token was found in any of them. The exposure is **names + internal
4-digit employee codes**, inside a **private** repository.

**Consequence for V2 — the rule this audit exists to establish:**

> Real names and employee codes exist in the sibling private repository. **V2 is public.** Therefore any future
> V2 work that consumes this project must take **aggregate counts only** — never rosters, names, codes, entry
> logs or screenshots. This mirrors the discipline the generator itself already applies to Agent Core
> (`CodexWorker/docs/agent-core-jev-integration.md`: the adapter sends *"aggregate counts and verification flags
> only… does not send employee names, raw attendance events, credentials, screenshots"*).

## 5. The FY2569 evidence (material for R-04)

`CodexWorker/prepared/README.md` (REPORTED by the project, with `verify_prepared.py` **18/18 PASS** and
per-file SHA-256 in `_build_meta.json`) documents a fully prepared **fiscal year 2569** data set:

* **Period stated as `ปีงบประมาณ 2569 (ต.ค.2568–ก.ย.2569)`** — i.e. **October 2025 → September 2026**.
* **53 employee codes**, every month having daily data.
* Monthly aggregate counts (**safe**, no personal data):

| Month (BE) | Late | Early | Half-day leave | Needs review |
|---|---:|---:|---:|---:|
| ต.ค. 2568 | 144 | 4 | 1 | 4 |
| พ.ย. 2568 | 125 | 3 | 0 | 0 |
| ธ.ค. 2568 | 148 | 3 | 1 | 0 |
| ม.ค. 2569 | 165 | 0 | 1 | 0 |
| ก.พ. 2569 | 141 | 2 | 1 | 1 |
| มี.ค. 2569 | 157 | 0 | 2 | 0 |
| เม.ย. 2569 | 128 | 0 | 1 | 0 |
| พ.ค. 2569 | 128 | 0 | 1 | 0 |
| มิ.ย. 2569 | 105 | 1 | 2 | 0 |
| ก.ค. 2569 | 131 | 4 | 0 | 0 |
| ส.ค. 2569 | 117 | 3 | 1 | 0 |
| ก.ย. 2569 | 111 | 4 | 0 | 3 |
| **Total** | **1,600** | **24** | **11** | **8** |

* It also records **26 person-month discrepancies between HIP and the monthly report**, deliberately resolved
  and documented in three groups: **12** accepted by the owner, **9** reclassified as half-day leave, **5**
  attributed to single-scan handling. 8 items are explicitly **withheld from entry** pending confirmation.

**Why this matters to V2:** this is not merely "a historical file". It is a real, externally produced
reconciliation result *including its known mismatches* — exactly what R-04 was blocked on. It also independently
**corroborates two things R-04 asserted**:

1. the **fiscal year is October–September** (R-04's `fiscalYearPeriod`, open item **R-04-F**), and
2. the **strict late/early boundary**, and that holidays are skipped.

## 6. Corrections this audit forces in V2

The audit makes two statements I wrote earlier today **factually stale**. Both are corrected in this commit.

| Location | Was | Now |
|---|---|---|
| `docs/unified/11…` §6.1, §8 | "`G:\ProjectAI\attendance-report-generator` DOES NOT EXIST" | It **does** exist; it was absent when checked at ~13:53 and ~14:06 and present at ~14:24 |
| `docs/unified/12…` §3, `NEXT_ACTIONS.md` R-04-B, `DECISIONS.md` §3 | R-04 blocked because the **source is missing** | The source **exists**; what remains is **integration**, which has not been done. `realSourceVerified: false` stays correct because nothing external was consulted — but the *reason* changes from "unavailable" to "not yet integrated" |

**Still stale in code, deliberately NOT changed by this audit** (flagged for decision, see §7 item 2):
`backend/src/domain/reconciliation.js` `REAL_SOURCE_NOTE` says *"No external FY2569 source … was available or
consulted"*. The "was available" clause is no longer true; "consulted" still is.

## 7. Findings, ranked

| # | Severity | Finding |
|---|---|---|
| 1 | **governance (high)** | Real employee names + internal codes are committed in 13 tracked files of the sibling repo. It is **private**, so this is not a public leak — but it is the reason V2 (public) must consume this project at **aggregate level only**. No national IDs were found. |
| 2 | **accuracy (medium)** | V2's `AR-0001` `sourceOfTruth` reads *"donor attendance-core config/settings.yaml"*. `attendance-core` has **no `config/` directory and no `settings.yaml`** (VERIFIED); the file is in **this** project. The rule values are correct; the **file citation is wrong**, and it is a provenance record on an approved rule (V2 risk R2). |
| 3 | **accuracy (medium)** | My own R-04 docs/`REAL_SOURCE_NOTE` said the reference "does not exist" / "was not available". Now false in the "available" half. Corrected for docs; the code string is left for a decision. |
| 4 | **process (medium)** | The generator's own Agent Core doc defines a **browser scope** (`POST /v2/browser/plan`) and a `monthly_save_clicked` guard stopping before the ERP save. V2's activated scope is `decision` only. If V2 ever inherits the ERP-filling workflow, that guard and the human-only save rule must come with it. |
| 5 | **low** | The generator's leave-alias matcher (`ลา → อื่นๆ`) is live in the donor. V2 rejected it (E13) but **P-07 is still open**, so the two systems can disagree about leave until P-07 is decided. |
| 6 | **low** | The generator has **uncommitted local WIP** (3 modified, 26 untracked). Not touched by this audit; another writer owns it. |
| 7 | **informational** | `attendance-core`, `agent-core` and `RAE-Attendance-System-V2` are **public**; only `Attendance-Report` is private. V2's own PII rules are therefore not helped by the sibling's privacy — they must be enforced in V2. |

## 8. What this changes for V2 (proposed next actions)

| ID | Action | Why |
|---|---|---|
| **R-04-B** | Re-scope from *"source missing"* to *"source exists, integration not done"* | The evidence is now available; the honest blocker is that no V2 code reads it |
| **R-04-C** *(new)* | Integrate FY2569 **aggregate** evidence as a reconciliation fixture — the 12 monthly aggregate counts and the 26 documented person-month discrepancies — with **no names and no codes** | Would turn R-04 from fixture-validated to **evidence-validated**, using data that already exists in a sibling private repo |
| **R-04-F** | Fiscal-year confirmation is now **corroborated** (the donor labels FY2569 as ต.ค.2568–ก.ย.2569 = Oct–Sep) | Downgrades the risk; owner confirmation still desirable |
| **DOC-R2** | Fix the `AR-0001` provenance citation to name the correct file/repo | An approved rule should cite a path that exists |
| — | Decide whether to replace the stale clause in `REAL_SOURCE_NOTE` | It is user-visible output text; it should not claim a source was unavailable when it is not |

## 9. Reproduction

Read-only. Every claim above is reproducible with:

```powershell
cd G:\ProjectAI\attendance-report-generator
git.exe remote -v                                   # -> numtip/Attendance-Report
git.exe status -sb                                  # -> main...origin/main (in sync)
gh repo view numtip/Attendance-Report --json visibility
git.exe ls-files | measure                          # -> tracked file count
git.exe check-ignore -v 06-june2026.csv input/logs output   # -> all ignored
python -m pytest --collect-only -q                  # -> 53 tests collected
```

The PII scan used `git ls-files` plus a `\b\d{13}\b` count and a "4-digit code followed by a Thai name"
heuristic over tracked text files — **counts and paths were recorded, never values**. The Thai monthly table in
§5 is copied from the project's own committed `README.md`, which contains no personal data in that section.

## 10. Declaration

This audit **changed nothing** in `G:\ProjectAI\attendance-report-generator`: no file created, edited, deleted,
staged, committed or pushed; its branch (`main` @ `658a0ea`, unchanged), its **1 stash** and its uncommitted WIP
(3 modified + 26 untracked files) were left exactly as found; it was never executed (no pipeline run) and no
data file was read beyond schema/aggregate level. Nothing contacted a production host or database. No secret,
token or national ID was retrieved, and no personal value was copied into this document or into V2.
