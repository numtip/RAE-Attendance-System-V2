# RAE Employee Master Reconciliation — 2026-10-20

**Mode:** local only. Production frozen. No VPS/SSH, no DB write, no migration, no deploy, no SSO
activation, no import, no commit/push. Every source file was opened read-only.

**Verdict: `PARTIAL_WITH_BLOCKERS`**

> **Update — later on 2026-10-20:** `docs/RAE_CROSS_SOURCE_RECONCILIATION_20261020.md` resolves two
> entries below against approved FY2569 evidence. The **21-row discrepancy is now VERIFIED**
> (12 accepted + 9 reclassified half-day; 5 single-scan complete the 26), and the **2 SSO UUID placeholder
> records are confirmed UNVERIFIABLE** in every artefact. The dataset and hashes here are unchanged; that
> document supersedes only those two rows.

**Jev (Agent Core) consulted once: `disposition=FALLBACK`, `decision=defer_to_human`,
`confidence=0.06`.** Advisory only; it is not an approval and nothing here depends on it.

One line: all 54 owner-confirmed rows are accounted for, 50 of 54 identities are traceable to the
2027 ID-card CSV by exact device code, **0 fabricated identities, 0 role assignments, 0 national IDs
emitted**, and import is still blocked by missing mandatory employee fields plus four unresolved
identity records.

---

## 1. Scope, sources and integrity

| Source | Role | SHA-256 (verified before and after the run) | Rows |
|---|---|---|---|
| `docs/RAE_Employee_Roster_Update20261020.xlsx` | owner-confirmed master (sheet `ตรวจแก้รายชื่อ 54 รหัส`) | `eee09b83185b9372e181d14f2d29b5e9718213c2bbf8609e52cc9ca327da55dd` | 54 data rows + 10 instruction rows |
| `database/IDCardRaecsv2027.csv` | reference names / departments / national-ID source | `65323dff8d618834205e8bb07839caa7133b1f8cf3c11e921ebe4c6546cf4443` (matches the baseline in `docs/SESSION_HANDOFF.md`) | 52 data rows → 50 unique people |

* The workbook was **not modified**: the pipeline hashes it before and after and aborts if the hash
  changes. The CSV was opened read-only and is never rewritten.
* CSV encoding is **UTF-8 with BOM** (`utf-8-sig`). Header: `ID card Code, Facescan Code, name, หน่วยงาน`.
* The workbook has no hidden/merged cells, no formulas and no trailing-whitespace or BOM defects.
* National IDs exist only in the CSV. The recovery dataset stores a **row reference**, never the value.

### 1.1 The three referenced evidence documents do not exist

`RAE_EMPLOYEES_RECOVERY_EVIDENCE_AUDIT.md`, `RAE_EMPLOYEES_RECOVERY_VERIFICATION.md` and
`RAE_EMPLOYEES_RECONCILIATION_QA.md` are absent from the working tree (tracked, untracked **and**
gitignored directories), from every local and remote branch, from `git rev-list --all --objects`
(so no deleted commit carries them), from the editor file history, and from all 20 prior transcripts in
this project. `git log --all -S"1032"` returns zero commits. The only local trace of the 54-code audit
is the workbook's own instruction sheet (`คำแนะนำ` cell `B3`), which cites
`RAE_EMPLOYEES_RECOVERY_VERIFICATION.md (2026-10-20)` and restates four of its conclusions.

Verified per-fact: **54 codes**, **`1032` device-only**, **`1015` master-only** and the
**`2012/2014/2017` name conflicts** exist only in that sheet. **"52 previously verified"**, the
**2 SSO UUID placeholders** and the **21-row discrepancy** are recorded in no artefact at all — not in
the workbook, not in the repo, not in history. Those three are therefore unverifiable claims, and this
document treats them as such rather than as established facts.

Consequence: the audit **conclusions** are reproducible (they are re-derived below from the primary
sources), but the audit **evidence** (the 2026 master export and the device export behind "52 verified",
the two SSO UUID placeholders and the 21-row discrepancy) is not available locally. This is recorded as
a documentation blocker, not hidden.

The only out-of-repo candidate evidence is `G:\ProjectAI\attendance-report-generator\CodexWorker\prepared\`
(67 files incl. rosters, entry logs, `events.csv`, `monthly_summary.csv`). It is **not usable here**:
`docs/memory/DECISIONS.md` restricts that directory to aggregate counts only and forbids reading rosters
or per-person codes. It is named so a future, explicitly-approved investigation can go there instead of
re-deriving nothing.

---

## 2. Workbook validation

| Check | Result |
|---|---|
| Data rows | 54 (rows 2–55), none fully blank |
| Report codes | 54 non-blank, all ASCII digits, all length 4, **54 distinct** (0 duplicates) |
| Codes matching CSV `Facescan Code` | 50 of 54 (exact string match) |
| Rows with a 2027 reference name/department | 52 (all except `1013`, `1015`) |
| Rows with an owner-confirmed employee code | 53 (`1015` blank) |
| Rows with an owner-confirmed name | 52 (`1013`, `1015` blank) |
| Employment status | 29 × `ปฎิบัติงาน` (**misspelling of ปฏิบัติงาน**), 23 × `ปฏิบัติงาน`, 1 × `เกษียณอายุ/ลาออก`, 1 × `ลาออก` |
| Employee-code cell type | 44 stored as **numbers**, 9 as text. No leading zero is lost (no code starts with `0`), but the type is a defect for a `VARCHAR` key |
| Reference name vs owner name | 52/52 equal; no residual spelling conflict inside the workbook |
| Department | 37 unchanged vs the 2027 CSV, **15 changed** in the owner's current data; 3 distinct current units (28 / 16 / 8 people) |
| Title prefix | 52 present (นาย / นาง / นางสาว / ว่าที่ร้อยตรี), 2 blank (`1013`, `1015`) |
| Duplicate whole rows | 0 |

### 2.1 Workbook defects found

1. **`1031` / `1032` reference provenance is wrong.** Their `ชื่อจาก CSV บัตร 2027` cells are filled,
   but no CSV row has code `1031` or `1032`, and their names do not occur anywhere in the CSV. The
   column label therefore asserts a source that cannot be produced. `1032` is the device-only case the
   owner confirmed; both are treated as new hires whose reference must be supplied by the owner.
2. **`1013` and `1015` are code-only records.** No name, no title, no department (and `1015` has no
   employee code). They cannot become employee rows because the target schema requires names.
3. **`1015` has no device code by definition** (master-only, no scan). This is now explicit in the
   dataset instead of being an empty cell.
4. **Status vocabulary is not canonical** (two spellings of the same state). Mapped explicitly; the
   variant is reported, not silently corrected.
5. **No position column exists in the workbook at all**, so position cannot be imported from it.
6. **15 department changes** are real (owner-confirmed current unit differs from the 2027 CSV). The
   dataset keeps both values; the import must write the current one and retain the CSV one as history.

---

## 3. Reconciliation with the previous 54-code audit

| Audit item | Reconciliation result |
|---|---|
| 54 codes | **54/54 reproduced**, identical code set, unique, no additions/removals |
| 52 previously verified | **The label "52 previously verified" is documented nowhere.** No artefact states it: the number 52 occurs only as the CSV row count and as the count of non-blank `ชื่อจาก CSV บัตร 2027` cells, both of which are arithmetic, not verification. Independently re-derived: **50** rows have exact device-code evidence in the 2027 CSV; the other **2** are `1031`/`1032` (new hires) whose reference data is untraceable (§2.1). So 52 = 50 verifiable + 2 with a filled reference cell, and "verified" overstates what the sources prove. |
| `1032` device-only | **Resolved**: owner confirmed a current employee (`ยืนยัน/พนักงานใหม่`); mapped as active. Code retained as both device code and employee code. |
| `1015` master-only | **Confirmed**: no device code, no name, no employee code; owner marked resigned. Remains an exception. |
| `1013` (in 2026 master, no 2027 CSV row) | Confirmed resigned; code-only record, no name → exception. |
| `2012`, `2014`, `2017` name conflicts | Owner-confirmed spelling **equals the 2027 CSV** spelling for all three, so the conflict is resolved toward the CSV. The rejected 2026 spelling was not recorded, so the resolution is not independently auditable. |
| 2 SSO UUID placeholder records | **Not in the workbook and not documented anywhere.** The instruction sheet only states that 32-character SSO UUIDs were excluded; no artefact — repo, branch, history or transcript — records a count of 2, so the figure is unverifiable. No local file contains such subjects. They are therefore **unmapped**; they must not be turned into employees or given invented subjects. |
| CSV duplicates | Codes `1020` and `1021` each appear twice with identical national ID, name and department (rows 14/15 duplicate 9/10). Collapsed to one person each; the duplicate row numbers are preserved in the dataset. |
| 52 CSV rows / 50 people | Reproduced exactly: 2 exact duplicates → 50 unique. |
| 21-row discrepancy | **Not reproducible.** Neither the audit document, the 2026 master export nor the device export exists locally, no repo text contains "21-row", and the nearest documented discrepancy is a different one (26 FY2569 person-month items in `docs/unified/12_SLICE6_RECONCILIATION.md`). The only candidate source is the out-of-repo `CodexWorker\prepared\` set, which policy limits to aggregate counts — so it cannot be investigated without a new approval. Stays open (blocker B12). |

**Accounting:** 54 codes = 50 CSV-backed identities + 4 exceptions (`1013`, `1015` no CSV; `1031`,
`1032` untraceable reference). Nothing was dropped.

---

## 4. Canonical employee mapping

Defined in `database/local/recovery-20261020/`:

| Field | Meaning | Status |
|---|---|---|
| `person_key` | `RPT-<report_code>` — a **local surrogate for this worksheet only** | not an SSO subject, not a UUID, do not import |
| `employee_code` | owner-confirmed employee code (`รหัสพนักงานล่าสุด`) | 53/54 present, unique |
| `device_code` | code the attendance device used (`รหัสที่พบในรายงาน`) | 53/54 present (empty for `1015`), unique |
| `full_name_th` / `title_th` | owner-confirmed name and prefix, unsplit | 52/54 present |
| `department_current` | owner-confirmed current unit | 52/54 present |
| `department_reference_2027` | unit in the 2027 CSV, kept as history | 52/54 present |
| `employment_status` / `active` | `active` \| `resigned` \| `UNKNOWN` | 52 active, 2 resigned |
| `identity_kind` | always `UNRESOLVED` — no MJU/HIP evidence exists locally | intentional |
| `personnel_id`, `sso_subject` | always empty | **never fabricated** |
| `national_id_source_ref` | `IDCardRaecsv2027.csv#row N` | no national ID value is copied |
| `role` | always empty | **no automatic role assignment** |
| `historical_code_ownership.csv` | code → person, role of the code (`device_code`, `employee_code`, `facescan_id`), source and evidence status | 104 code claims over 54 people |

Effective dates (`valid_from`/`valid_to`) are deliberately **empty**: the 2026 master and device
export are unavailable, so any date would be invented. `employee_assignment` needs them before import.

---

## 5. Exception register (97 rows)

| Type | n | Severity | Meaning |
|---|---|---|---|
| `CODE_STORED_AS_NUMBER` | 44 | warn | employee code was a numeric cell; normalized to text for import |
| `EMPLOYMENT_STATUS_SPELLING_VARIANT` | 29 | warn | `ปฎิบัติงาน` normalized to `ปฏิบัติงาน`/`active` |
| `DEPARTMENT_CHANGED` | 15 | info | current unit differs from the 2027 CSV (history preserved) |
| `CSV_EXACT_DUPLICATE_COLLAPSED` | 2 | info | codes `1020`, `1021`; duplicate CSV rows recorded |
| `CSV_REFERENCE_UNTRACEABLE` | 2 | **blocker** | `1031`, `1032` reference names not present in the CSV |
| `OWNER_NAME_MISSING` | 2 | **blocker** | `1013`, `1015` |
| `EMPLOYEE_CODE_MISSING` | 1 | **blocker** | `1015` |
| `MASTER_ONLY_NO_SCAN` | 1 | warn | `1015` |
| `DEVICE_ONLY_CONFIRMED` | 1 | info | `1032`, resolved by owner confirmation |

---

## 6. Data-quality defects addressed (local code only)

| Defect | Change | Test |
|---|---|---|
| **UTF-8 BOM handling** | `scripts/data-onboarding/map-idcard-identity-kinds.mjs` read the file as `latin1` and then stripped `\uFEFF` — a character that can never appear after a `latin1` decode (the BOM becomes `ï»¿`). Replaced by `decodeCsvBuffer()`: strips a real UTF-8 BOM, decodes UTF-8, falls back to a single-byte decode only when the bytes are not valid UTF-8. | 4 new tests: BOM+Thai, legacy single-byte, CLI end-to-end with a BOM file, CSV left byte-identical |
| **Missing device code** | Master-only `1015` gets an explicit empty `device_code` plus an exception; the reconciliation never derives a device code from a name. The identity CLI already fails closed (`HIP_ID_MISSING` → `UNRESOLVED`). | `test_missing_device_code_for_master_only_row`, CLI test "a row with a missing device code is reported, never silently dropped" |
| **Duplicate attendance prevention** | Existing contract kept: `buildSourceEventKey()` (USERID+CHECKTIME+sensor+type+verify+workcode) gives idempotency, `lib.mjs` rejects overlapping `daily_attendance` keys, and `reconciliation.test.js` already covers duplicate scans. CSV duplicate rows are collapsed without losing their row numbers. | `test_exact_duplicate_collapses_and_no_silent_row_loss`, existing `onboarding.test.mjs` overlap tests |
| **21-row discrepancy** | **Not fixed — cannot be investigated** without the missing audit document or a device export. Recorded as blocker B12 instead of being guessed. | n/a |
| **Regression tests** | 15 Python tests (pipeline) + 50 JS tests (onboarding/identity) pass. | see §7 |

The pipeline itself (`scripts/data-recovery/build_recovery_dataset.py`) treats BOM, duplicate,
missing-code and no-fabrication rules as invariants with unit tests.

---

## 7. QA results

Command: `python -m unittest discover -s scripts\data-recovery -p "test_*.py"` → **15/15 pass**.
Command: `node --test scripts/data-onboarding/{onboarding,map-idcard-identity-kinds,identityKindMapping,identifierCrypto}.test.mjs backend/tests/idcardCsvIdentity.test.js` → **50/50 pass**.

| Gate | Result | Evidence |
|---|---|---|
| Identity uniqueness | **Partial** | 53 employee codes, 0 duplicates; 53 device codes, 0 duplicates; 2 records have no name and 1 has no code → not import-ready |
| Code ownership conflicts | **Pass** | no code maps to two people; no device code is shared by different identities; no code differs between device and employee code |
| Historical attendance linkage | **Fail (evidence missing)** | 50/54 traceable to the 2027 CSV; `1013`, `1015`, `1031`, `1032` cannot be linked to a 2026/device record locally |
| No silent row loss | **Pass** | 54 workbook rows → 54 records; 52 CSV rows → 50 people + 2 duplicates explicitly recorded |
| No unauthorized role assignment | **Pass** | `role` is empty for all 54; no role source is read |
| No fabricated SSO identifiers | **Pass** | `sso_subject` and `personnel_id` are empty for all 54; `identity_kind` is always `UNRESOLVED` |
| No PII leakage | **Pass** | 0 national-ID-like 13-digit sequences and 0 national-ID values in every output file; national IDs stay only in the source CSV |

---

## 8. Import readiness assessment

`proposed_import_mapping.json` lists every target column. Summary:

| Target | Source | Status |
|---|---|---|
| `employees.employee_id` | `employee_code` | ready behind a uniqueness gate (53/54) |
| `employees.department` | `department_current` | ready |
| `employees.status` | `employment_status` | ready (`active` 52 / `resigned` 2) |
| `employees.role` | — | NULL by policy |
| `employees.first_name_th` / `last_name_th` | one owner name field | **blocked** — splitting Thai names is inference |
| `employees.email` | — | **blocked** — NOT NULL/UNIQUE, no source |
| `employees.employee_type` | — | **blocked** — NOT NULL enum, no source |
| `employees.employee_uid` | — | **blocked** — allocation policy not approved |
| `employees.position` | — | NULL (no workbook column) |
| `employee_identifier.facescan_id` | `device_code` | ready with effective dates |
| `employee_identifier.employee_id` | `employee_code` | ready with effective dates |
| `employee_identifier.national_id` | CSV (HMAC lookup only) | **blocked** — key/flow not approved; raw value never copied |
| `employee_identifier.personnel_id` | — | empty (no MJU evidence) |
| `employee_assignment` | current + 2027 department | **blocked** until effective dates are known |

### Blockers

* **B1** `first_name_th` / `last_name_th` require an owner-approved name split (or a schema/import decision).
* **B2** `email` has no source but is `NOT NULL UNIQUE`.
* **B3** `employee_type` has no source but is `NOT NULL`.
* **B4** `employee_uid` allocation policy not approved.
* **B5** `1013`, `1015` have no owner-confirmed name.
* **B6** `1031`, `1032` reference provenance is untraceable (and `1015` has no employee code).
* **B7** national-ID import needs the HMAC contract key and an approved lookup-only flow.
* **B8** `employee_assignment` effective dates are unknown.
* **B9** the 2 SSO UUID placeholder records are unmapped and must not be materialized.
* **B10** historical attendance linkage for 4 codes cannot be proven without the 2026 master/device export.
* **B11** the three referenced audit documents are missing from the repo (verified across the tree,
  all local/remote branches, `git rev-list --all --objects`, editor history and all 20 prior transcripts).
* **B12** "52 previously verified", the 2 SSO UUID placeholders and the 21-row discrepancy are asserted
  in the request but appear in no artefact; they cannot be reconciled, only re-derived from scratch
  (or investigated in `CodexWorker\prepared\`, which needs a separate approval under `DECISIONS.md`).

None of these is a reason to touch production; all are reasons not to import yet.

---

## 9. Outputs

| Path | Content | Git |
|---|---|---|
| `docs/RAE_EMPLOYEE_MASTER_RECONCILIATION_20261020.md` | this report | untracked |
| `database/local/recovery-20261020/normalized_employee_master.csv` | 54 canonical people (no national IDs, no IDs invented) | gitignored |
| `database/local/recovery-20261020/identity_reconciliation.csv` | per-code match method, confidence, provenance | gitignored |
| `database/local/recovery-20261020/historical_code_ownership.csv` | 104 code claims with source and evidence status | gitignored |
| `database/local/recovery-20261020/unresolved_exceptions.csv` | 97 exceptions | gitignored |
| `database/local/recovery-20261020/reconciliation_report.json` | machine-readable QA + source hashes | gitignored |
| `database/local/recovery-20261020/proposed_import_mapping.json` | column-level import plan + blockers | gitignored |
| `database/local/recovery-20261020/source_provenance.json` | hashes and encoding | gitignored |
| `scripts/data-recovery/build_recovery_dataset.py` | reproducible pipeline (read-only) | untracked |
| `scripts/data-recovery/test_build_recovery_dataset.py` | 15 regression tests | untracked |
| `scripts/data-onboarding/map-idcard-identity-kinds.mjs` (+ test) | BOM fix + 4 tests | modified, uncommitted (file exists only on the integration branch, not on `main`) |

The output directory is inside `database/local/`, already protected by `.gitignore`; the personal data
stays local and is not part of any commit.

---

## 10. Gates

| Gate | Status |
|---|---|
| Excel validated | **PASS with defects** (hash-verified unchanged; 54 unique codes; six defects in §2.1) |
| Identity reconciliation documented | **PASS** (54 records, 50 CSV-backed, 4 explicit exceptions) |
| Historical mappings preserved | **PARTIAL** (2027 CSV + workbook preserved; 2026 master/device history unavailable) |
| Data quality tests pass | **PASS** (15 Python + 50 JS) |
| Import readiness assessed | **PASS** (assessment complete; result is "blocked") |

## 11. Verdict

**`PARTIAL_WITH_BLOCKERS`** — the owner-confirmed workbook is valid, fully accounted for, and safe to
keep as the canonical reference; the recovery dataset is generated and QA'd without fabricating any
identity, role or national ID. Import approval is not possible until B1–B3 and B5–B6 are resolved by the
owner and B7–B8 are approved operationally.

Nothing was committed, pushed, deployed, migrated or written to any server.
