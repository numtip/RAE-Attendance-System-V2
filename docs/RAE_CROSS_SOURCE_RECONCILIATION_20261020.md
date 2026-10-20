# RAE Cross-Source Evidence Reconciliation — 2026-10-20

**Phase:** cross-source evidence reconciliation. **Read-only.** No production change, no DB write, no
migration, no deploy, no SSO activation, no commit/push. No source file, CSV or workbook was modified.

**Verdict: `PARTIAL_WITH_BLOCKERS`**

> **Update — `FY2569_PRIMARY_EXPORT_ATTESTATION.md` (same day)** supersedes the primary-export and
> population claims below. **10 of 12** primary HIP exports were located and **hash-matched**, the
> derivation chain reconciles with zero residual on all 10 available months, and the 53/54 delta is
> **resolved to the single resigned code `1015`**. Accordingly: **C1 withdrawn** — the exports are present,
> not absent; **C5 closed**; **C6 closed**. The attendance findings here stand and are now strengthened.
> Treat the "not present" clause in the paragraph below as superseded.
master, 0 foreign codes, 0 duplicates), and the reported **21-row discrepancy is resolved and verified**.
The verdict is held down by four things: the 12 primary HIP exports are **not present** (so derived counts
cannot be re-derived), the **SSO UUID placeholder claim is unverifiable**, the weekly **roster evidence is
empty of codes**, and a **53-vs-54 population delta** remains unresolved.

---

## 1. Preflight

### 1.1 Authorization and the policy conflict it creates

`docs/memory/DECISIONS.md` **E57** (line 121; restated at 178–179) says the sibling
`numtip/Attendance-Report` project may be consumed by V2 **at aggregate level only** — "no names, no
employee codes, no rosters, no entry logs, no screenshots" — because that project is private and holds real
names while this repo is public.

The owner has now explicitly authorized limited read-only access to
`CodexWorker/prepared/` for this investigation. That is a **narrow, dated exception to E57**, not a repeal
of it. Recorded delta:

| Rule | Before | This investigation | After |
|---|---|---|---|
| Read rosters / entry logs / per-person files | forbidden | permitted for reconciliation only | forbidden again |
| Employee codes in a deliverable | forbidden | permitted (owner calls 4-digit codes non-sensitive) | forbidden in the public repo unless owner restates |
| Names anywhere | forbidden | **still forbidden** — memory only | forbidden |
| Person-level exports | forbidden | **still forbidden** — none created | forbidden |

I opened **7 of 66** files (the minimum for reconciliation) and left the 12 person-level extracts
(`p25_*`, `p26_*`), all `*-entry-log.json`, the plans, screenshots and UI audits **unread**.

> **Security finding:** `CodexWorker/prepared/README.md` contains a **plaintext code→name table**
> (line 52) plus per-person breakdowns. The directory is therefore *not* PII-free, contrary to any
> assumption that it is "aggregate-safe". Nothing from it may be copied into this public repo, and the
> owner should treat the directory as PII-bearing for retention/ACL purposes. Read-only access did not
> change the file.

### 1.2 Source inventory (hashes computed read-only)

**Primary repo — owner-confirmed master**

| File | Bytes | SHA-256 |
|---|---:|---|
| `docs/RAE_Employee_Roster_Update20261020.xlsx` | 14,075 | `eee09b83185b9372e181d14f2d29b5e9718213c2bbf8609e52cc9ca327da55dd` |
| `database/IDCardRaecsv2027.csv` | 7,005 | `65323dff8d618834205e8bb07839caa7133b1f8cf3c11e921ebe4c6546cf4443` |

**Approved evidence root:** `G:\ProjectAI\attendance-report-generator\CodexWorker\prepared\`
(66 files, snapshot mtime 2026-10-06/07 — i.e. **before** the 2026-10-20 owner workbook).

| File | Bytes | SHA-256 | Role |
|---|---:|---|---|
| `_build_meta.json` | 22,100 | `9d12f4873a95a67ac3b9016b37dec7234d75789b2f323d8cb139a9969d6f9840` | build manifest + 26-row mismatch register + provenance |
| `events.csv` | 713,997 | `6f2c19bc4bcab0e172e4993c23a965f95a0c9f4a90386b883f25ec243a46f00c` | derived late/early-leave events |
| `monthly_summary.csv` | 40,605 | `9d562e51a42f902670c936c86653751c19a2ae460995a05aecdebcf617c5ede3` | derived person-month counts |
| `needs_review.csv` | 6,941 | `79c01d86c58ef3039418a46d32ddf9a79c9ae4e90113262579e9d62df487ad3e` | 8 review rows |
| `half_day_leave.csv` | 8,367 | `4fd59b07cadb032ce0e985b0bb118b192b9e69dc5cc79e7c304769af8c8840ce` | 11 half-day rows |
| `august2569-roster.json` | 8,901 | `53bd58a49207d5230e82ad96f3f8ec2169177bf91a26e3c2d21b90d93a1b5d12` | roster (see §3.4) |
| `README.md` | 11,289 | `b1a9621971ef80de10a0798da79252f03ef263d1aaa2944385019948aae2d930` | taxonomy source; **contains names** |

**Critical provenance gap.** `_build_meta.json` records **30** inputs, but only their name, sha256 and row
count — **not their content**. The 12 primary monthly HIP exports (1,590–1,643 rows each) and the daily
dataset that produced `daily_codes = 53` are **not in `prepared/`**. `events.csv` and
`monthly_summary.csv` are *derived artefacts*; the pipeline that derived them cannot be re-run or
independently audited here.

---

## 2. Cross-source reconciliation (codes only, never names)

| Measure | Result |
|---|---|
| Master codes | **54** (all 4-digit numeric, unique) |
| `events.csv` rows / distinct codes | 1,624 / **48** |
| `monthly_summary.csv` rows / distinct codes | 338 / **48** |
| Evidence codes that exist in the master | **48 / 48 (100%)** |
| Evidence codes **not** in the master (foreign codes) | **0** |
| Master codes with zero late/early events | **6** (`2006`, `3009`, `3024`, `3026`, `3032`, `3033`) |
| Codes mapped to more than one person | **0** |
| Name-based identity merges performed | **0** — forbidden by rule, never attempted |

**Interpretation guard.** `events.csv` contains **only** `มาสาย` (late) and `กลับก่อน` (left early) rows
(1,600 + 24). A code absent from it is **not** proven absent from work — it may simply have never been
late. I therefore do **not** claim those 6 people lack attendance; they lack *evidence either way*, which
is a different and weaker statement.

### 2.1 The `1031` / `1032` investigation (independently)

These were the two codes flagged as "reference name untraceable to the 2027 CSV" in the previous report.
The FY2569 evidence resolves their **existence** without resolving their **2027 card batch** membership:

| Code | Events | Months seen | First → last | Finding |
|---|---:|---|---|---|
| `1031` | 16 | 7 (Nov 2025 – Sep 2026) | 2025-11-07 → 2026-09-25 | A real, continuously monitored employee across the whole fiscal year |
| `1032` | 7 | 5 (May 2026 – Sep 2026) | 2026-05-25 → 2026-09-16 | A real employee who **joined mid-year** — consistent with the owner's "new employee" note |

This reframes both exceptions. `1032` is no longer ambiguous: the owner said "device-only, current
employee" and the evidence shows a mid-year entrant. The remaining defect is narrow and clerical —
**the workbook's "name from CSV 2027" cell cannot be backed by any CSV row**. `1031`/`1032` are therefore
**graded VERIFIED for identity existence and OWNER_CONFIRMED for employment status**, while their
*provenance column* stays CONFLICTED.

### 2.2 `1015` — the one genuine contradiction

The workbook status is `มีใน Master แต่ไม่พบสแกน` ("in Master, no scan found"), yet `1015` has **1 late
event on 2026-02-09**. Both cannot be true as written.

Resolution (INFERRED, not proven): the "no scan" claim refers to the **2027 ID-card batch**, where `1015`
is genuinely absent, while the FY2569 event proves historical scan activity. That is fully consistent with
the owner marking `1015` **resigned**. Grade: **CONFLICTED as worded, coherent under the 2027-batch
reading.** The workbook note should be reworded rather than the data changed.

`1013` is not contradictory: 2 events (2026-02-24, 2026-08-21), marked resigned, no "no scan" claim.

### 2.3 Population delta: 53 (HIP) vs 54 (master)

| Series | Value | Source |
|---|---|---|
| Master workbook codes | 54 | owner workbook |
| HIP export population per note | 53 | `_build_meta.json` source notes ("53 รหัส") |
| Daily codes per month | 53 (constant, 12 months) | `_build_meta.json` `per_month` |
| Monthly report people | **54** in 2025-11 and 2025-12, **53** otherwise | `per_month.report_people` |
| Report rows ignored as resigned | 7 | `stats.ignored_resigned_report_rows` |

So the master's 54 matches the **report's** Nov/Dec population, not HIP's 53. Exactly **one person** exists
on one side only, and I cannot identify which one from `prepared/` because the primary exports are absent.
Recorded as an unresolved one-code delta, not guessed. (`1032` is *not* the answer — it has events.)

### 2.4 The roster files are unusable for identity

All four roster files (`may/june/july/august2569-roster.json`) are **byte-identical** —
sha256 `53bd58a4…` for all four. That alone disqualifies them as month-specific evidence.

| Property | Finding |
|---|---|
| Entries | 35 |
| Employee codes present | **0** — fields are `counts`, `editId`, `group`, `name` only |
| `editId` | 116–117 characters — a form/entry identifier, **not** a UUID, not an employee code |
| `counts` | **one distinct value across all 35 rows**, shape `0/0/0` |
| Coverage vs 54 master | 35 names, unmatchable without a name join |

Conclusion: the roster is a **blank 35-person checklist duplicated into four months**, carrying no codes
and no attendance counts. It contributes **zero** reconciliation signal and must not be cited as evidence
of monthly staffing. Any past claim that four monthly rosters were reviewed is **unsupported**.

---

## 3. Attendance investigation — the 21-row discrepancy

### 3.1 Resolved: what "21" actually is

The FY2569 evidence documents **26 person-month discrepancies** between HIP and the monthly report,
split into **three groups** (`prepared/README.md`):

| Group | Count | Meaning |
|---|---:|---|
| Accepted | 12 | Difference acknowledged, no action |
| Reclassified as half-day leave | 9 | The report row is explained by approved leave |
| **Subtotal — the "21-row discrepancy"** | **21** | **Rows that genuinely differ and need a human decision** |
| Single-scan, HIP-only | 5 | HIP saw one scan; the report has no row |
| **Total** | **26** | The documented register |

**Verified, not inferred:** all 12 accepted, all 9 reclassified and all 5 single-scan
(code, month) pairs are present in `_build_meta.json → count_mismatches_passed`. 12 + 9 = **21**, which is
exactly the figure under investigation. The earlier "not reproducible" status is now **closed**.

The 9 reclassified pairs are `2016`(Oct), `1018`(Dec), `3002`(Feb), `1007`(Mar), `3016`(Mar), `2007`(May),
`2004`(Jun), `3013`(Jun), `3044`(Aug). The 5 single-scan pairs are `2005`(Dec), and
`2007`/`2012`/`3013`/`3016`(Jan).

### 3.2 A defect in the taxonomy itself

12 + 9 + 5 = **26 rows**, but there are only **25 distinct** person-months: `3016` in January is
classified **both** as "accepted" and as "single-scan". So:

* the group counts are **row** counts, not population counts;
* the true distinct discrepancy population is **25**, not 26;
* the 21 itself is sound (the accepted and reclassified groups do not overlap each other).

This is a documentation defect in the source taxonomy, not a data defect. It should be corrected upstream
so 26 is not quoted as "26 people/months".

### 3.3 Independent count verification (recomputed from the CSVs)

| Check | Recomputed | Manifest | Match |
|---|---:|---:|---|
| `events.csv` rows | 1,624 | 1,624 | ✅ |
| Late events (`มาสาย`) | 1,600 | 1,600 | ✅ |
| Early-leave events (`กลับก่อน`) | 24 | 24 | ✅ |
| Per-month late sum | 1,600 | 1,600 | ✅ |
| Per-month early sum | 24 | 24 | ✅ |
| `needs_review.csv` rows | 8 | 8 | ✅ |
| `half_day_leave.csv` rows | 11 | 11 | ✅ |
| `monthly_summary.csv` late sum | 1,600 | 1,600 | ✅ |
| `monthly_summary.csv` half-day sum | 11 | 11 | ✅ |
| Duplicate `event_id` | 0 | none expected | ✅ |
| Duplicate (code, date, type) | 0 | `true` | ✅ |
| Duplicate (month, code) in summary | 0 | — | ✅ |

### 3.4 Source rows vs normalized events vs persisted records

Kept strictly distinct, as required:

| Layer | Artefact | Count | Status |
|---|---|---|---|
| **Source rows** | 12 monthly HIP exports | 1,590–1,643 each | **ABSENT** — only hashes in the manifest |
| **Normalized events** | `events.csv` | 1,624 | present, internally consistent |
| **Person-month rollup** | `monthly_summary.csv` | 338 | present, sums reconcile |
| **Persisted attendance records (V2)** | V2 database | **0** | proof of concept only; `realSourceVerified: false` |
| **Duplicate handling** | — | — | already deduplicated upstream (`no_duplicate_person_date_type: true`); **nothing was deleted or re-deduplicated by me** |

One identifier note: `source_flag_value` appears in `events.csv`, and the Aug export is marked "corrected
remark 3013", while `aug_orig` is marked superseded. The current `events.csv` therefore reflects the
**corrected** August export — which is why `sha` `6c8bf81d…` (aug_orig) is *not* the build input.

---

## 4. SSO investigation

| Test | Result |
|---|---|
| UUID / 32-hex tokens in any `prepared/` file | **0** (scanned all 6 data files) |
| Distinct 32-hex values repo-wide | 5, all in **tests and docs** |
| Of those, all-same-character placeholders | 2 distinct values, 3 occurrences, in one test file (`backend/tests/ssoMjuTokenFlow.test.js`) |
| Zero-UUID (`00000000-…`) | 3 occurrences in tests, all **not-found negative cases** |
| SSO identity records in the evidence | **none** |

**Finding: the "2 SSO UUID placeholder records" cannot be traced to any record.**

* **UNVERIFIABLE** as person records — no file, workbook, branch, history or transcript contains them.
* **INFERRED (weak)** possible origin of the number: there are exactly **2 distinct placeholder UUID
  constants** in the local test suite. That is a coincidence of count, not evidence of two people, and I do
  not claim it as the source.
* Per the rules, **no UUID→person mapping was inferred, attempted or written.** No SSO identifier appears
  in this report.

**Consequence for import:** there is nothing to reconcile, and therefore nothing to import. `employee_uid`
stays an allocation decision for the approved import gate (§7); SSO subjects stay empty.

---

## 5. Evidence grading

| # | Finding | Grade |
|---|---|---|
| 1 | Master contains 54 unique 4-digit codes, hash-pinned and unchanged | **VERIFIED** |
| 2 | All 48 observed evidence codes belong to the master; 0 foreign codes | **VERIFIED** |
| 3 | No code maps to two people in either source | **VERIFIED** |
| 4 | `1031` is a real employee across 7 months of FY2569 | **VERIFIED** (existence) |
| 5 | `1032` is a real mid-year entrant (first event 2026-05-25) | **VERIFIED** (existence) |
| 6 | `1031`/`1032` are current employees | **OWNER_CONFIRMED** |
| 7 | `1031`/`1032` "CSV 2027" reference names | **CONFLICTED** — no CSV row exists |
| 8 | `1015` "no scan" vs 1 Feb event | **CONFLICTED** as worded; coherent as "no 2027 card" → **INFERRED** |
| 9 | 21-row discrepancy = 12 accepted + 9 reclassified | **VERIFIED** |
| 10 | 5 single-scan rows complete the 26 | **VERIFIED** |
| 11 | FY2569 totals 1,600 late / 24 early / 8 review / 11 half-day | **VERIFIED** (internally) |
| 12 | Those totals match the original HIP exports | **UNVERIFIABLE** — exports absent |
| 13 | Roster files carry no codes and are byte-identical across 4 months | **VERIFIED** |
| 14 | 2 SSO UUID placeholder records | **UNVERIFIABLE** |
| 15 | 53 (HIP) vs 54 (master) population delta | **UNVERIFIABLE** identity; **VERIFIED** as a count difference |
| 16 | 6 master codes have no attendance evidence | **UNVERIFIABLE** (absence of lateness ≠ absence of work) |
| 17 | V2 has any persisted attendance from this source | **VERIFIED NO** (`realSourceVerified: false`) |

---

## 6. QA

| Gate | Result | Method |
|---|---|---|
| Independent count verification | **PASS** | every total recomputed from the CSVs, not copied from the manifest (§3.3) |
| No duplicate identity assignments | **PASS** | 48 codes → 48 distinct people; 0 shared device codes |
| No silent row loss | **PASS** | 1,624 = 1,624 events, 8 = 8 review, 11 = 11 leave, 338 summary rows with 0 duplicate keys |
| No unsupported historical claims | **PASS** | every claim dated and hash-pinned; the roster myth in §2.4 corrected rather than repeated |
| No PII or secret leakage | **PASS** | 0 names, 0 national IDs, 0 UUIDs, 0 emails in this report (scanned against the workbook, event `employee_name` and roster name sets) |
| Preserve source provenance | **PASS** | full SHA-256 for every file used; the 4 byte-identical rosters share one hash |
| No person-level export created | **PASS** | none written; no JSON/CSV side artefact produced |
| Source files unmodified | **PASS** | read-only opens; no write handle taken |

---

## 7. Remaining blockers

| ID | Blocker | Why it matters | Owner of the fix |
|---|---|---|---|
| **C1** | The 12 primary HIP exports are absent; only hashes survive | Derivations cannot be re-run or audited independently of the derived files | Data owner / sibling project |
| **C2** | 2 SSO UUID placeholder records untraceable | Cannot be imported or excluded on evidence; only a decision closes it | Owner statement |
| **C3** | `1031`/`1032` 2027 reference-name provenance is false as labelled | A "reference" column asserting a source that does not contain the person | Owner (relabel or supply source) |
| **C4** | `1015` status note contradicts an actual event | Wording, not data; risks a wrong "no scan" conclusion later | Owner (reword) |
| **C5** | 53-vs-54 population delta unresolved | One unidentified person is on one side only | Needs the primary exports (C1) |
| **C6** | 6 master codes have no attendance evidence | Cannot be confirmed or excluded | Needs the daily dataset (C1) |
| **C7** | Roster evidence unusable (no codes, 4 identical copies, all-zero counts) | Any monthly staffing claim based on it is unsupported | Sibling project |
| **C8** | Upstream taxonomy double-classifies `3016` January | "26" overstates the population (25) | Sibling project README |
| **C9** | `prepared/README.md` contains a plaintext code→name table | The "aggregate-safe" assumption is wrong; PII exposure risk | Owner (ACL/retention) |
| **C10** | Master is a 54-code list, not an importable employee master | Still missing name split, email, employee type, `employee_uid` policy, effective dates | Owner + import gate |

C1 is the root blocker: it is the only one that would also close C5 and C6.

---

## 8. Recommended next recovery gate

**Gate name:** `FY2569_PRIMARY_EXPORT_ATTESTATION`

Do **not** advance to import approval from this report. The next gate should be a single, narrow step:

1. The owner (or the sibling project's operator) supplies **either** the 12 primary HIP monthly exports
   **or** a signed attestation that `_build_meta.json`'s 30 sha256 values are the complete input set and
   that no export was omitted. Without one of those, C1/C5/C6 cannot close.
2. In the same step, answer two one-line questions: **which code is the 53-vs-54 delta** (C5), and
   **what the 2 SSO UUID placeholders were** (C2).
3. Then, and only then, re-run this reconciliation against the primary exports and re-grade
   findings 12, 15 and 16.

Import approval remains gated on C10 regardless of C1–C9.

---

## 9. Provenance of this report

* Master workbook and ID-card CSV hashes re-verified before and after the investigation — unchanged.
* Evidence accessed read-only: 7 of 66 files in `CodexWorker/prepared/` (§1.2).
* No DB, no VPS, no SSH, no credential or `.env` access, no cross-host transfer.
* Nothing staged, committed or pushed. No file created other than this report.
* Cumulative with `docs/RAE_EMPLOYEE_MASTER_RECONCILIATION_20261020.md` (2026-10-20), which remains the
  canonical employee-master dataset; this report adds cross-source evidence and **supersedes** its
  "21-row discrepancy" and "2 SSO UUID placeholders" entries.
