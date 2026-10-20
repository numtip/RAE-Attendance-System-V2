# FY2569 Attendance Integration Report — 2026-10-20

**Phase:** `FY2569_ATTENDANCE_INTEGRATION`. **Local implementation + isolated QA.**
No VPS access or writes, no production database change, no deployment, migration or SSO activation,
no commit/push. Every source file was opened read-only; no source, master workbook or CSV was modified.

**Verdict: `READY_FOR_VPS_RECOVERY_REVIEW`**

Readiness for the **review**, not for import. The attendance dataset is attested 12/12, reconciles with
**zero unexplained rows**, and survives an idempotent/rollback rehearsal. Employee-master import remains
**hard-blocked** by four NOT NULL columns that have no authorized source (proven, not assumed — see §4).

---

## 1. E1 owner decision — recorded

| Item | Value |
|---|---|
| Decision | `OWNER_CONFIRMED_DISTINCT_IDENTITIES` |
| Codes | `1015`, `1032` |
| Rule | Never merge their identities or their attendance |
| `1032` | New employee; 11 months of evidence |
| `1015` | Resigned March 2026; February 2026 attendance must be preserved |
| Exact employment dates | **Remain unverified** — no date is invented anywhere in the dataset |

Recorded in `integration_manifest.json` (`owner_decision_e1`) and enforced by the rehearsal (§5.4).

**Consistency check against the attested evidence** — the owner decision and the exports agree:

| Code | Exports present | Exports absent | Rows in dataset | Date span |
|---|---|---:|---:|---|
| `1032` | **11 months** | February | **337** | 2025-10-01 → 2026-09-30 |
| `1015` | **1 month** (February) | 11 months | **28** | 2026-02-01 → 2026-02-28 |

The 11-month / 1-month split matches the owner's statement exactly, and the two codes **share no
calendar date** (0 overlapping rows). The previous phase's conflicting hypothesis is now closed by owner
authority, and the dataset keeps the two streams physically separate.

---

## 2. Source and schema mapping

### 2.1 Attested sources (12/12, hash-verified at build time)

The builder **re-hashes every source and aborts on any mismatch** before reading a row.

| Month | Rows | SHA-256 (prefix) | Codes |
|---|---:|---|---:|
| 2025-10 | 1,643 | `547db42b2a37` | 53 |
| 2025-11 | 1,590 | `8851a11ead0c` | 53 |
| 2025-12 | 1,643 | `d20a0e698246` | 53 |
| 2026-01 | 1,643 | `7643ab4c2865` | 53 |
| 2026-02 | 1,484 | `6b0c04a9c9db` | 53 |
| 2026-03 | 1,643 | `25113774a4d8` | 53 |
| 2026-04 | 1,590 | `64c6952d5875` | 53 |
| 2026-05 | 1,643 | `020baacff631` | 53 |
| 2026-06 | 1,590 | `7a7f87398717` | 53 |
| 2026-07 | 1,643 | `cf990f75a0a3` | 53 |
| 2026-08 | 1,643 | `e77c2760f561` | 53 |
| 2026-09 | 1,590 | `959e081e83b3` | 53 |
| **Total** | **19,345** | — | **54 distinct (union)** |

Three header shapes exist in the source (3 exports lack `สถานะ`, 1 lacks it and adds `เวลาทำงาน{1}`).
The builder handles all three by column **name**, never by position beyond the four fixed leading columns.

### 2.2 Employee master → target schema

Validated against `002_employees.sql`, `003`/`013_employee_identifier`, `004_daily_attendance`,
`005_monthly_summary`, `020_employee_assignment`.

| Target column | Source | Status |
|---|---|---|
| `employee_uid` | — | **BLOCKED** — allocation policy not approved; never derived from an identifier |
| `employee_id` | `employee_code` | **partial** — 53 of 54; `1015` has no employee code in the workbook (left blank in the dataset, not filled in) |
| `first_name_th` / `last_name_th` | one owner name field | **BLOCKED** — splitting a Thai name is inference |
| `email` | — | **BLOCKED** — `NOT NULL UNIQUE`, no source |
| `department` | `department_current` | ready (3 distinct org units) |
| `position` | — | absent (no workbook column) |
| `employee_type` | — | **BLOCKED** — `NOT NULL` enum, no source |
| `hire_date` / `status` | `employment_status` | status ready; **hire_date absent** |
| `role` | — | NULL by policy — no automatic role assignment |
| `employee_identifier.facescan_id` | `device_code` | ready — 54 identifiers (evidence-backed only) |
| `employee_identifier.employee_id` | `employee_code` | ready — 54 identifiers |
| `employee_identifier.national_id` | ID-card CSV (HMAC only) | **BLOCKED** — key/flow not approved; raw value never copied |
| `employee_identifier.personnel_id` | — | empty (no MJU evidence) |
| `employee_assignment` | current + 2027 department | **BLOCKED** — effective dates unverified |
| `daily_attendance.*` | HIP exports | ready (§3) |

### 2.3 Exports → `daily_attendance` mapping

| Target | Source column | Rule |
|---|---|---|
| `date` | `วัน/เวลา` | `DD/MM/BBBB` (BE) or ISO; BE→CE by `-543`; unparsable → exception, never a guess |
| `check_in` / `check_out` | `เข้า [1]` / `ออก [1]` | verbatim `HH:MM:SS` |
| `is_late` / `late_minutes` | `สาย [1]` | `is_late=1` iff minutes > 0 |
| `is_leave` / `leave_type` | `Remark [1]` | `ป่วย`→sick, `กิจ`→personal, `พักผ่อน`→vacation, `ไปราชการ`→other |
| `status` | `สถานะ` + scans + remark | see §3.3 |
| `notes` | `source_key` | provenance token (month key) |

**Explicitly not mapped:** employee names are never written into the attendance dataset. The name column
exists in the source and is ignored by the builder.

---

## 3. Normalized data counts

| Measure | Value |
|---|---:|
| Source rows read | **19,345** |
| Normalized rows written | **19,345** |
| Duplicates removed | **0** |
| Unparsable dates | **0** |
| Rows without a device code | **0** |
| **No silent row loss** | **TRUE** (19,345 = 19,345 + 0) |
| Distinct employee codes | **54** |
| Months covered | **12 / 12** |

### 3.1 Status distribution

| `status` | Rows | Basis |
|---|---:|---|
| `present` | 10,168 | scan present, no lateness |
| `late` | 1,601 | `สาย [1]` > 0 |
| `leave` | 798 | leave remark in the mapped vocabulary |
| `absent` | 305 | **125 stated by the source** (`ขาดงาน`) + **180 inferred** (no scan, no leave, working day) |
| `holiday` | 6,473 | source `วันหยุด` + inferred weekends/holidays |
| **Total** | **19,345** | |

### 3.2 Confidence split — nothing inferred is hidden

| Confidence | Rows | Meaning |
|---|---:|---|
| `DERIVED` | 17,840 | the source states it (status column, scan, or explicit remark) |
| `INFERRED` | 1,505 | 1,325 weekend/holiday rows in the 3 exports lacking `สถานะ` + 180 no-scan absences |

**Every one of the 1,505 inferred rows is listed individually** in `attendance_exceptions.csv`
(exception type `ATTENDANCE_INFERRED`). Nothing inferred is silent.

Working-day inference for the 3 exports without a `สถานะ` column (`2025-10`, `2026-03`, `2026-09`) uses
two facts **proven** on the 9 exports that do carry it:
1. **no workday ever falls on Sat/Sun** (verified: 0 workdays on weekends in Jan/May/Jul),
2. **public holidays carry a holiday label** in `Remark`.
That covers 4,876 rows and is flagged `WORKDAY_INFERRED_FROM_CALENDAR_AND_HOLIDAY_VOCAB`.

### 3.3 Flag inventory

| Flag | Count |
|---|---:|
| `WEEKEND_INFERRED` | 1,325 |
| `HOLIDAY_LABEL` | 896 |
| `LEAVE_NO_SCAN` | 714 |
| `INCOMPLETE_SCAN_REMARK` | 670 |
| `NO_SCAN_OUT` | 508 |
| `NO_SCAN_IN` | 278 |
| `ABSENT_INFERRED_NO_SCAN` | 180 |
| `ABSENT_STATED_BY_SOURCE` | 125 |
| `OFFICIAL_DUTY` | 77 |
| `WORKDAY_INFERRED_FROM_CALENDAR_AND_HOLIDAY_VOCAB` | 4,876 |

### 3.4 Historical code ownership preserved

Each row carries `source_key`, `source_file`, `source_sha256` and `source_row`, so any target row can be
traced to one line of one attested file. `1015`'s February rows and `1032`'s eleven months remain
distinct `employee_code` values with **no cross-assignment**.

---

## 4. Isolated import rehearsal

**Environment limitation, stated plainly:** this machine has **no MariaDB/MySQL server and no Docker**.
The rehearsal therefore uses a **disposable SQLite file** with the schema transcribed from the migration
files. Deviations: `ENUM`→`CHECK`, `AUTO_INCREMENT`→`AUTOINCREMENT`, `ENGINE`/`CHARSET` dropped.
**No foreign key was invented** — and `daily_attendance` deliberately keeps **no FK**, because
`004_daily_attendance.sql` declares none.

### 4.1 PASS A — schema exactly as written

| Check | Result |
|---|---|
| Import of the 54-row owner master | **REJECTED_AS_EXPECTED** |
| First failure | `NOT NULL constraint failed: employees.email` |
| Rows committed | **0** (the transaction is atomic) |

Rows that cannot satisfy the schema as written:

| Column | Rows unable |
|---|---:|
| `first_name_th` | 2 (the two code-only records) |
| `last_name_th` | **54** (no surname field exists) |
| `email` | **54** (no source at all) |
| `employee_type` | **54** (no source at all) |
| `employee_uid` | **54** (policy not approved) |

This is the proof behind §2.2: the blocker is real and mechanical, not an opinion.

### 4.2 PASS B — relational rehearsal (only the 4 unavailable NOT NULLs relaxed)

| Check | Result |
|---|---|
| Employees imported | **54** |
| Identifiers imported | **108** (54 `employee_id` + 54 `facescan_id`) |
| `daily_attendance` imported | **19,345** |
| `monthly_summary` derived | **636** person-months |
| **Idempotent re-import** | **PASS** — identical counts *and* identical content fingerprint |
| **Rollback** | **PASS** — forced duplicate-identifier abort left the DB byte-identical, all 19,345 rows intact |
| Orphan `daily_attendance` rows | **0** |
| Duplicate (employee, date) | **0** |
| FK enforced on `employee_identifier` | **PASS** (rejects an unknown `employee_uid`) |
| `daily_attendance` accepts an orphan | **YES** — correct, because migration 004 declares no FK; the FK is **not** assumed |
| **`1015` vs `1032` separation** | **PASS** — different `employee_uid`, 28 vs 337 rows, **0 shared dates** |
| Rehearsal-only keys | deterministic UUIDv5 in a **disposable** file, labelled non-authoritative |

**Disclosed coercion, rehearsal only:** `1015` has **no `employee_code`** in the owner workbook. The
dataset correctly leaves it blank; the rehearsal substitutes the device code so the `NOT NULL` column can
be exercised. That substitution is a **test harness convenience, not an approved mapping** — it is
blocker **F10** and must be resolved by the owner before any real import.

**Rehearsal-only identifiers:** `employee_uid` values in the SQLite file are generated from a rehearsal
namespace. They are **not** allocated identities and must never be copied to any host.

---

## 5. QA

| Gate | Result | Evidence |
|---|---|---|
| **12/12 source attestation** | **PASS** | every source re-hashed before use; mismatch aborts the build |
| **Employee identity uniqueness** | **PASS** | 54 codes, 54 distinct employees, 0 duplicate `employee_id` |
| **Historical code ownership** | **PASS** | `1015` = 28 Feb rows, `1032` = 337 rows over 11 months, 0 shared dates, never merged |
| **Source-to-target reconciliation** | **PASS** | 19,345 → 19,345; §5.1 below |
| **No unexplained row loss** | **PASS** | 0 duplicates, 0 dropped, 0 unparsable |
| **Idempotent import** | **PASS** | re-import reproduces an identical fingerprint |
| **Attendance/leave rule regression** | **PASS** | 40/40 data-recovery tests; **526 pass / 12 skipped / 0 fail** backend suite |
| **No PII or secret leakage** | **PASS** | no names, national IDs, UUIDs or emails in this report or in any console output |

**PII scan detail.** A naive `\d{13}` scan of the dataset returns 3,286 hits; all are **substrings of the
`source_sha256` provenance column** (2 distinct values, both verified as hash fragments). No national ID
is present. The attendance dataset carries **no name column at all** — names exist only in
`employee_master_integration.csv`, inside the gitignored directory, because the import target requires
them.

### 5.1 Reconciliation against the previously derived artefacts

| Month | This dataset late | `events.csv` late | Δ | Official-duty rows | `monthly_summary` late |
|---|---:|---:|---:|---:|---:|
| 2025-10 | 144 | 144 | 0 | 0 | 144 |
| 2025-11 | 125 | 125 | 0 | 0 | 125 |
| 2025-12 | 148 | 148 | 0 | 0 | 148 |
| 2026-01 | 165 | 165 | 0 | 0 | 165 |
| **2026-02** | **142** | **141** | **1** | **1** | **141** |
| 2026-03 | 157 | 157 | 0 | 0 | 157 |
| 2026-04 | 128 | 128 | 0 | 0 | 128 |
| 2026-05 | 128 | 128 | 0 | 0 | 128 |
| 2026-06 | 105 | 105 | 0 | 0 | 105 |
| 2026-07 | 131 | 131 | 0 | 0 | 131 |
| 2026-08 | 117 | 117 | 0 | 0 | 117 |
| 2026-09 | 111 | 111 | 0 | 0 | 111 |
| **Total** | **1,601** | **1,600** | **1** | **1** | **1,600** |

**The single difference is fully explained:** February `3940` on 2026-02-19 carries a 48-minute late scan
*and* the official-duty remark `งานรับปริญญา`. `events.csv` had already excluded it; this dataset
**preserves the raw scan** and flags it `OFFICIAL_DUTY`, so the evidence is not destroyed.
Every monthly delta equals its official-duty count, and the early-leave chain matches `events.csv`
**exactly in all 12 months** (24/24).

The previously verified 21-row classification and the 26-entries / 25-unique-person-months finding are
unchanged and re-confirmed by this reconciliation.

---

## 6. Outputs

All generated data is inside one **gitignored** directory — verified with `git check-ignore`
(`.gitignore:16: database/local/`), and `git status` reports **0** untracked files under it.

| Path | Content | Git |
|---|---|---|
| `database/local/fy2569-integration-20261020/daily_attendance_normalized.csv` | 19,345 rows, full provenance | ignored |
| `database/local/fy2569-integration-20261020/attendance_exceptions.csv` | 1,505 inferred rows | ignored |
| `database/local/fy2569-integration-20261020/employee_master_integration.csv` | 54 employees + schema gaps | ignored |
| `database/local/fy2569-integration-20261020/integration_manifest.json` | hashes, counts, E1 record | ignored |
| `database/local/fy2569-integration-20261020/reconciliation_vs_derived.json` | §5.1 | ignored |
| `database/local/fy2569-integration-20261020/rehearsal/` | disposable SQLite + result JSON | ignored |
| `scripts/data-recovery/build_fy2569_integration.py` | dataset builder | untracked |
| `scripts/data-recovery/rehearse_fy2569_import.py` | rehearsal harness | untracked |
| `scripts/data-recovery/reconcile_fy2569_dataset.py` | §5.1 reconciliation | untracked |
| `scripts/data-recovery/test_fy2569_integration.py` | 25 regression tests | untracked |
| `docs/FY2569_ATTENDANCE_INTEGRATION_REPORT.md` | this report | untracked |

---

## 7. Remaining blockers

| ID | Blocker | Impact | Closes with |
|---|---|---|---|
| **F1** | `employees.email` — `NOT NULL UNIQUE`, no source | Import impossible (proven in PASS A) | Owner decision: supply emails, or approve a schema change with a documented placeholder policy |
| **F2** | `first_name_th`/`last_name_th` — one owner name field | 54/54 rows cannot satisfy | Owner-approved name split, or a single-field schema |
| **F3** | `employee_type` — `NOT NULL` enum, no source | 54/54 rows cannot satisfy | Owner supplies employment type per person |
| **F4** | `employee_uid` allocation policy not approved | No canonical identity can be created | Approve an allocation policy (UUIDv4 at import, never derived) |
| **F5** | Effective dates unverified (`hire_date`, `effective_from/to`) | `employee_assignment` cannot be populated | Owner supplies dates, or approve open-ended windows |
| **F6** | `1015` and `1013` have no owner-confirmed name | 2 rows remain code-only | Owner supplies names or confirms exclusion |
| **F7** | Rehearsal ran on SQLite, not MariaDB | FK/ENUM/DDL behaviour proven by faithful translation, not on the real engine | Run the same harness against a disposable MariaDB before production import |
| **F8** | 180 absences are inferred, not stated | Downstream reports could overstate absence | Business rule sign-off on the "no scan + no leave = absent" rule |
| **F9** | National-ID import path unapproved | `national_id` identifiers cannot be created | Approve the HMAC lookup-only flow |
| **F10** | `1015` has no `employee_code` (blank in the owner workbook) | `employee_id` cannot be populated for that row; the rehearsal substituted the device code as a harness convenience only | Owner supplies the code, or approves device code as employee code for this one record |

F1–F4 are the hard gate. F7 is the only *methodological* caveat and should be closed at the VPS stage.
F10 is small but must not be silently absorbed.

---

## 8. VPS-A recovery readiness assessment

| Dimension | Assessment |
|---|---|
| Attendance evidence | **READY** — 12/12 attested, 19,345 rows, zero loss, exact reconciliation |
| Attendance import mechanics | **READY** — idempotent, rollback-safe, no duplicate (employee, date), provenance per row |
| Identity separation (`1015`/`1032`) | **READY** — owner-confirmed, physically separate in dataset and rehearsal |
| Employee master | **NOT READY** — F1–F4 hard-block, F5/F6 incomplete |
| Production DDL behaviour | **UNVERIFIED** — rehearsed on SQLite only (F7) |
| Production/VPS state | **UNTOUCHED** — no access this phase |

VPS-A's own database is unreadable (InnoDB error 1932, orphaned tablespaces per
`docs/DB_EMPLOYEES_1932_INVESTIGATION.md`). This phase produces a **clean, attested attendance dataset
that can seed a recovered instance** — it does not attempt recovery, and it makes no assumption about
what VPS-A still holds.

---

## 9. Recommended next gate

**Gate:** `EMPLOYEE_MASTER_SCHEMA_RESOLUTION`, then `MARIA_DB_REHEARSAL`.

1. Owner resolves **F1–F4** (email policy, name field, employment type, `employee_uid` allocation).
   Without these the rehearsal cannot become an import — this is proven, not predicted.
2. Re-run `rehearse_fy2569_import.py` against a **disposable MariaDB** to close **F7**, confirming
   ENUM/CHECK/FK behaviour and that `daily_attendance` still has no FK.
3. Only then consider a VPS-A recovery import, under a separate approval that includes a rollback plan.

Attendance data itself needs no further evidence work. The gate is entirely about the employee schema.

---

## 10. Provenance

* Sources read-only: 10 exports under the sibling `input/logs/`, plus `febcsv2026xlsx.xlsx` and
  `4april.csv` under `D:\Doc`. All 12 re-hashed and matched before use.
* Master `docs/RAE_Employee_Roster_Update20261020.xlsx` — `eee09b83…` (unchanged).
* No `.env`, credential or secret accessed. No VPS, SSH, database server or network call.
* Nothing staged, committed or pushed. No file created outside the gitignored dataset directory and this
  report.
