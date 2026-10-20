# FY2569 Primary Export Completion — 2026-10-20

**Phase:** `PRIMARY_EXPORT_COMPLETION`. **Read-only.** Exactly two files under `D:\Doc` were opened; no other
path under `D:\Doc` was read, listed recursively, or hashed. No source file was modified or copied. No `.env`,
credential or secret access. No DB write, import, migration, VPS operation, or commit/push. WIP, worktrees,
`stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` untouched.

**Verdict: `ATTESTED_READY_FOR_RECOVERY_REVIEW`**

All **12/12** primary HIP exports now hash-match the manifest. Both event chains reconcile with **zero
residual in all 12 months**. The 26-row register is **26/26 verified against primary data**. Two prior
findings of mine are corrected below, and one new identity question is handed to the recovery review.

---

## 1. Preflight

| Item | Result |
|---|---|
| Approved paths resolved unambiguously | **Yes** — exactly as recorded in the attestation (§2.3) and `_build_meta.json` |
| `D:\Doc\fingerscan\2026\Total\febcsv2026xlsx.xlsx` | present, 74,224 bytes, mtime 2026-04-03 16:22 |
| `D:\Doc\fingerscan\2026\Total\ai\4april.csv` | present, 270,540 bytes, mtime 2026-06-05 13:36 |
| Ambiguity requiring STOP | **none** |
| Other `D:\Doc` access | **none** |
| Manifest source | `G:\ProjectAI\attendance-report-generator\CodexWorker\prepared\_build_meta.json`, sha256 `9d12f487…` |

---

## 2. Twelve-month attestation matrix

| Month | Key | Expected sha256 (manifest) | Computed | Verdict | Rows | Rec. rows | Codes |
|---|---|---|---|---:|---|---:|---:|---:|
| 2025-10 | `oct` | `547db42b…ef63` | `547db42b…ef63` | **MATCH** | 1,643 | 1,643 | 53 |
| 2025-11 | `nov` | `8851a11e…4d58` | `8851a11e…4d58` | **MATCH** | 1,590 | 1,590 | 53 |
| 2025-12 | `dec` | `d20a0e69…47d7` | `d20a0e69…47d7` | **MATCH** | 1,643 | 1,643 | 53 |
| 2026-01 | `jan` | `7643ab4c…a5ad` | `7643ab4c…a5ad` | **MATCH** | 1,643 | 1,643 | 53 |
| **2026-02** | `feb` | `6b0c04a9…3c79` | `6b0c04a9c9db220485321dea8a23266d09245dcf2fb55faab301f56852e83c79` | **MATCH** | **1,484** | 1,484 | 53 |
| 2026-03 | `mar` | `25113774…8fd6` | `25113774…8fd6` | **MATCH** | 1,643 | 1,643 | 53 |
| **2026-04** | `apr` | `64c6952d…adf0` | `64c6952d5875856f8a58f54f997378fd1b410ee7847d3ed2e18cb9cfcf48adf0` | **MATCH** | **1,590** | 1,590 | 53 |
| 2026-05 | `may` | `020baacf…f7ec` | `020baacf…f7ec` | **MATCH** | 1,643 | 1,643 | 53 |
| 2026-06 | `jun` | `7a7f8739…fa21` | `7a7f8739…fa21` | **MATCH** | 1,590 | 1,590 | 53 |
| 2026-07 | `jul` | `cf990f75…1143` | `cf990f75…1143` | **MATCH** | 1,643 | 1,643 | 53 |
| 2026-08 | `aug` | `e77c2760…8deb` | `e77c2760…8deb` | **MATCH** | 1,643 | 1,643 | 53 |
| 2026-09 | `sep` | `959e081e…bfc3` | `959e081e…bfc3` | **MATCH** | 1,590 | 1,590 | 53 |

**12 / 12 MATCH · 0 MISMATCH · 0 NOT_FOUND.** Every physical row count equals the recorded `rows_used`.
No mismatch occurred, so the phase's "stop on unexpected source/hash mismatch" rule was not triggered.

*Coverage moved 10/12 → **12/12***. Both newly attested files are the exact ones recorded, proven by digest
rather than filename.

---

## 3. February `1015` verification

The February export is the single XLSX in the set (`febcsv2026`, 13 header columns, `สาย [1]` at index 8).

| Check | Result |
|---|---|
| `1015` present in February? | **YES** |
| Rows for `1015` in February | **28** (one per calendar day, 2026-02-01 → 2026-02-28) |
| Rows with status `วันทำงาน` (working day) | **20** |
| Rows with status `วันหยุด` (holiday) | **8** |
| Late scans | **1** |
| Late scan date | **2569-02-09** (BE) = **2026-02-09** (CE) |
| Late amount | **00:04:00** |
| Late remark | `สาย` |
| No-scan-in day (`ไม่สแกนเข้า`) | 1 (no late recorded that day) |

**Comparison with the previously documented 2026-02-09 late event: exact match** — same date, one event,
same code. The prior inference is now **VERIFIED** from the primary export.

### 3.1 Consequence — the workbook note is factually wrong

`1015`'s workbook status is `มีใน Master แต่ไม่พบสแกน` ("in Master, no scan found"). The primary export shows
**20 working days with in/out times in February**. The note is **disproved**, not merely reworded.

Correct statement: `1015` was **employed through the whole of February 2026** and has one 4-minute late scan
on 2026-02-09. The "no scan" claim is only true of the **2027 ID-card batch**, where `1015` has no row.

### 3.2 Newly discovered: February substitutes `1015` for `1032`

| Code | Presence across the 12 exports |
|---|---|
| `1032` | present in **11** months — every month **except February** (30–31 rows/month, one per calendar day) |
| `1015` | present in **1** month — **February only** (28 rows, one per calendar day) |

February holds **53** codes like every other month, so this is a **1-for-1 substitution**, and the two codes
share **the same department** (equality on the org string, 1 distinct value each).

Two hypotheses remain, and the evidence available **cannot separate them**:

| | Hypothesis | Supporting evidence | Against |
|---|---|---|---|
| **A** | Same person; February's export carries a legacy/alternate code (`1015`) for the person normally keyed `1032` | exact 1-for-1 swap; identical department; both have complete one-row-per-day coverage; the February file is the only XLSX (a different intermediate conversion) | the owner workbook lists them as two people with different statuses |
| **B** | Two distinct people: `1015` worked only February and resigned; `1032`'s February rows are an export gap | `1015`'s February data is complete and self-consistent; `1015` is owner-marked resigned | `1032` would then have a silent whole-month export gap that the build never flagged |

**Grade: CONFLICTED.** No identity merge was performed, no name comparison was used, and no mapping was
inferred. This is handed to the recovery review as **E1** (§7). It does **not** affect the attestation:
both files are authentic, and both codes appear in exactly the months described.

---

## 4. Population 53/54 — final reconciliation

| Measure | Value |
|---|---:|
| Distinct codes in **every individual month** | **53** (12 of 12 months) |
| **Union of codes across the 12 months** | **54** |
| Codes present in **all 12** months | **52** |
| Master workbook codes | **54** |
| HIP union codes **not** in master | **0** |
| Master codes **not** in the HIP union | **0** |

**The 53/54 question is fully explained, and it was never a missing person:**

> Every month contains exactly **53** codes, but the union across the fiscal year is **54**, because
> **February substitutes `1015` for `1032`**. The master's 54 is the *union*, not a monthly headcount.

The master and the export set cover **exactly the same 54 codes** — a perfect set equality. There is no
code on one side only.

### 4.1 Two corrections to my previous report

| Previous statement | Status | Correct statement |
|---|---|---|
| "`1032` is a real mid-year entrant — first event 2026-05-25" | **WITHDRAWN** | `1032` appears in **11 of 12** monthly exports, so it was **employed all year**. 2026-05-25 was only its first *late* event. I had inferred tenure from late events, which was wrong. |
| "Master 54 = HIP 53 + `1015`; `1015` absent from all exports" | **WITHDRAWN** | `1015` **is** in the HIP exports (February). The union is 54 and equals the master exactly. The prior claim was an artefact of February being unattested. |
| "`1015` has no attendance evidence" | **WITHDRAWN** | `1015` has 20 working days and 1 late scan in February. |

Consequently the workbook's `1032` note (`ยืนยัน/พนักงานใหม่` — "new employee") is **also contradicted**:
`1032` is present from October 2025. Both owner notes for these two codes are inconsistent with the primary
evidence.

---

## 5. Primary → derived QA

Two independent chains were recomputed for **all 12 months** from the primary exports:

**(a) Late chain:** `primary late scans − half-day-replaced late − official-duty-excluded late = events.csv`

**(b) Early chain:** `primary early-leave scans − half-day-replaced early = events.csv`

| Month | P late | −HD | −Off | Derived | `events.csv` | Δ | P early | −HD | Ev early | Δ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-10 | 145 | 1 | 0 | 144 | 144 | **0** | 4 | 0 | 4 | **0** |
| 2025-11 | 125 | 0 | 0 | 125 | 125 | **0** | 3 | 0 | 3 | **0** |
| 2025-12 | 149 | 1 | 0 | 148 | 148 | **0** | 3 | 0 | 3 | **0** |
| 2026-01 | 166 | 1 | 0 | 165 | 165 | **0** | 0 | 0 | 0 | **0** |
| **2026-02** | 143 | 1 | **1** | 141 | 141 | **0** | 2 | 0 | 2 | **0** |
| 2026-03 | 159 | 2 | 0 | 157 | 157 | **0** | 0 | 0 | 0 | **0** |
| **2026-04** | 128 | 0 | 0 | 128 | 128 | **0** | 1 | **1** | 0 | **0** |
| 2026-05 | 129 | 1 | 0 | 128 | 128 | **0** | 0 | 0 | 0 | **0** |
| 2026-06 | 107 | 2 | 0 | 105 | 105 | **0** | 1 | 0 | 1 | **0** |
| 2026-07 | 131 | 0 | 0 | 131 | 131 | **0** | 4 | 0 | 4 | **0** |
| 2026-08 | 118 | 1 | 0 | 117 | 117 | **0** | 3 | 0 | 3 | **0** |
| 2026-09 | 111 | 0 | 0 | 111 | 111 | **0** | 4 | 0 | 4 | **0** |

**Both chains reconcile exactly in 12/12 months. No unexplained row loss.**

Two exclusion rules are now **proven**, not assumed:

1. **Half-day-approval reclassification.** 11 rows in `half_day_leave.csv` each remove exactly one scan.
   `april / 1032 / ลาป่วย` removes the April early-leave scan; the other ten remove a late scan.
2. **Official-duty remark.** February's `3940` carries remark `งานรับปริญญา` (graduation event) on
   2026-02-19 with a 48-minute late amount, and is excluded from the late count. This is the single reason
   my previous phase showed `Δ=1` for February. It is a documented `needs_review` item, not a defect.

Residual remark categories across all late rows are `สาย` (genuine late), `ไม่สแกนออก` (no scan-out — still
counted late), plus `ป่วย` / `กิจ` / `ไปราชการ` / `งานรับปริญญา` only where a half-day row or official event
accounts for them.

### 5.1 The 21-row classification — now 26/26 verified against primary

| Group | Count | Verified against primary |
|---|---:|---|
| Accepted | 12 | **12 / 12** |
| Reclassified as half-day leave | 9 | **9 / 9** |
| **Subtotal = the 21-row discrepancy** | **21** | **21 / 21** |
| Single-scan (HIP only) | 5 | **5 / 5** |
| **Register total** | **26** | **26 / 26** |

Each verified row satisfies `register count + half-day + official-duty = primary count`. The ninth
reclassified row (`3002`, February) is now confirmed: register 4 + 1 half-day = **5** primary late scans.

**26 entries / 25 unique person-months is reconfirmed.** `3016` January remains classified as *both*
"accepted" and "single-scan", so 26 is an entry count and 25 is the population. The 21 is unaffected
because the accepted and reclassified groups do not overlap.

---

## 6. QA

| Gate | Result | Evidence |
|---|---|---|
| **SHA256 matches for all 12 exports** | **PASS 12/12** | table §2; 0 mismatch, 0 not-found |
| **Source row counts match manifest** | **PASS 12/12** | every month's physical rows = `rows_used` |
| **No duplicate identity ownership** | **PASS (with E1)** | 53 distinct codes/month, 54 distinct across year, no code maps to two people; the `1015`/`1032` substitution is an open *ownership* question, not a duplicate assignment |
| **No unexplained row loss** | **PASS** | both chains exact in 12/12 months; the two exclusion rules are identified and proven |
| **Evidence hashes unchanged** | **PASS** | master `eee09b83…`, ID-card CSV `65323dff…`, `_build_meta.json` `9d12f487…`, `events.csv` `6f2c19bc…` — all identical before and after |
| **No PII or secrets in report** | **PASS** | 0 names, 0 national IDs, 0 UUID values, 0 emails; names were never read into scope; only `code/date/remark/status` fields were projected |
| No source modification or copy | **PASS** | read-only opens; no file written outside this report |
| No other `D:\Doc` access | **PASS** | exactly two paths opened |

---

## 7. Remaining blockers

| ID | Blocker | Grade | Impact | Closes with |
|---|---|---|---|---|
| **E1** | February substitutes `1015` for `1032`; same dept, 1-for-1, unresolvable from exports | CONFLICTED | If same person, importing both creates a duplicate; if different, `1032` has a silent February export gap | Owner statement: **are `1015` and `1032` the same person?** |
| **E2** | `1015` note "no scan found" is disproved by 20 February workdays | VERIFIED WRONG | A wrong conclusion could be inherited by the import | Correct the workbook note (data unchanged) |
| **E3** | `1032` note "new employee" is contradicted — present since October 2025 | VERIFIED WRONG | Same class of risk as E2 | Correct the workbook note |
| **E4** | The 2 SSO UUID placeholder records have no evidentiary basis | UNVERIFIABLE | Nothing to reconcile | Withdraw the claim or name the artefact |
| **E5** | `prepared/` PII is tracked (50/66 files) in a private repo, no ignore rule, fully inherited ACL | VERIFIED (risk) | Contained by repo visibility alone; a future `git add` would commit more | Add ignore rules + explicit ACL; decide retention |
| **E6** | Roster files carry 0 codes and 4 byte-identical copies | VERIFIED | No monthly staffing signal | Regenerate with codes, per month |
| **E7** | Upstream quotes 26 where the population is 25 | VERIFIED | Misleading figure | Correct the taxonomy text |
| **E8** | Master still not importable (name split, email, employee type, `employee_uid` policy, effective dates) | VERIFIED | Blocks import, not attestation | Import gate |

**Evidence blockers are now zero.** E1–E3 are identity/provenance corrections; E4–E8 were carried over and
are unchanged in kind.

---

## 8. Recommended next gate

**Gate:** `RECOVERY_REVIEW_E1_RESOLUTION` — one owner decision, then the recovery review can proceed.

1. Answer: **are `1015` and `1032` the same person?**
   * *Same* → `1015` is a historical alias of `1032`; record it in `employee_identifier` with an effective
     window covering February 2026, and do **not** create a second employee.
   * *Different* → `1015` is a one-month employee (resigned after February) and `1032`'s February export gap
     must be accepted explicitly as missing evidence.
2. Correct the two workbook notes (E2, E3). No attendance data changes.
3. Then proceed to recovery review on **fully attested** FY2569 evidence.

Import approval remains gated on E8 and is unaffected by E1–E7.

---

## 9. Provenance of this report

* Newly opened, read-only: `D:\Doc\fingerscan\2026\Total\febcsv2026xlsx.xlsx` (74,224 B, sha256 `6b0c04a9…`),
  `D:\Doc\fingerscan\2026\Total\ai\4april.csv` (270,540 B, sha256 `64c6952d…`).
* Previously attested: 10 exports under `input/logs/` in the sibling project.
* Unchanged reference hashes: master `eee09b83…`, ID-card CSV `65323dff…`.
* No database, VPS, SSH or credential access. Nothing staged, committed or pushed. No file created other
  than this report.
* Supersedes the primary-export, `1015` and 53/54 sections of `docs/FY2569_PRIMARY_EXPORT_ATTESTATION.md`;
  its attendance-chain findings remain valid and are here extended to 12/12 months.
