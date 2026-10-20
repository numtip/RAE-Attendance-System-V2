# FY2569 Primary Export Attestation — 2026-10-20

**Phase:** `FY2569_PRIMARY_EXPORT_ATTESTATION`. **Read-only.** No source, CSV, workbook, database or
config was modified. No VPS access, no credentials, no `.env` read, no cross-host transfer, no
commit/push, no person-level export created.

**Verdict: `PARTIAL_WITH_BLOCKERS`**

> **Superseded — `FY2569_PRIMARY_EXPORT_COMPLETION.md` (same day).** All **12/12** primary exports now
> hash-match, both event chains reconcile with zero residual across all 12 months, and the register is
> 26/26 verified. **Three statements below are withdrawn:** `1032` was *not* a mid-year entrant (present in
> 11/12 exports), `1015` is *not* absent from the exports (20 February workdays), and the 53/54 delta is a
> **February `1015`↔`1032` substitution** — not "53 + `1015`". Read the completion report for current state;
> this document is retained for its derivation method and file inventory. The derivation chain
primary → events → summary reconciles **exactly, for every available month, with zero residual**. The
53/54 population delta is **resolved to a single code**. Two primary exports (February, April) sit
outside this phase's authorized root but **exist on disk** — one authorization line converts this to
`ATTESTED_READY_FOR_RECOVERY_REVIEW`.

---

## 1. Preflight

### 1.1 Restrictions carried forward

* `docs/memory/DECISIONS.md` **E57**: the sibling project is consumable at **aggregate level only**.
  This phase stays inside the owner's narrow exception: reconciliation reads only, **names never enter
  a deliverable**, no person-level export.
* Authorized root for this phase: `CodexWorker/prepared/` in the sibling project
  `G:\ProjectAI\attendance-report-generator`.
* `D:\Doc\fingerscan\` is **outside** that root. **Existence was probed, contents were not read and not
  hashed** (§2.3). This is deliberate, not an oversight.
* WIP, worktrees, `stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` untouched.

### 1.2 The 30 recorded input hashes

`_build_meta.json` (sha256 `9d12f487…`) records 30 inputs as **name + sha256 + row count**, not content:

| Role | Count | Authorized location per manifest |
|---|---:|---|
| `primary` | 12 | 10 × `input/logs/*.csv`, 2 × `D:\Doc\…` |
| `alternate` | 16 | all `D:\Doc\…` (incl. 11 person-level extracts) |
| `superseded` | 2 | `input/logs/08-aug2026.csv`, `input/logs/09-sep2026-1.csv` |

### 1.3 Evidence manifest produced

861 files were hashed across the authorized project tree (excluding `.git`, `node_modules`,
`__pycache__`, `.pytest_cache`, and every `.env*` / `*.key` / `*.pem`, which were skipped by name and
never opened). Result: **12 of 30 digests matched.**

---

## 2. Primary export attestation

### 2.1 Result per recorded input

| # | Key | Role | Recorded rows | Recorded path | Result |
|---:|---|---|---:|---|---|
| 1 | `oct` | primary | 1,643 | `input/logs/10-Oct2025.csv` | **MATCH** |
| 2 | `nov` | primary | 1,590 | `input/logs/11-Nov2025.csv` | **MATCH** |
| 3 | `dec` | primary | 1,643 | `input/logs/12-Dec2025.csv` | **MATCH** |
| 4 | `jan` | primary | 1,643 | `input/logs/1-Jan2026.csv` | **MATCH** |
| 5 | `feb` | primary | 1,484 | `D:\Doc\…\febcsv2026xlsx.xlsx` | **NOT_FOUND in authorized root** (file exists on disk — §2.3) |
| 6 | `mar` | primary | 1,643 | `input/logs/03-March2026.csv` | **MATCH** |
| 7 | `apr` | primary | 1,590 | `D:\Doc\…\ai\4april.csv` | **NOT_FOUND in authorized root** (file exists on disk — §2.3) |
| 8 | `may` | primary | 1,643 | `input/logs/05-May2026.csv` | **MATCH** |
| 9 | `jun` | primary | 1,590 | `input/logs/06-june2026.csv` | **MATCH** (also duplicated at project root) |
| 10 | `jul` | primary | 1,643 | `input/logs/july2026csv.csv` | **MATCH** (also as `july2026csv2.csv` at root) |
| 11 | `aug` | primary | 1,643 | `input/logs/08-aug2026-corrected.csv` | **MATCH** |
| 12 | `sep` | primary | 1,590 | `input/logs/09-Sep2026.csv` | **MATCH** |
| — | `aug_orig` | superseded | 1,643 | `input/logs/08-aug2026.csv` | **MATCH** (bonus) |
| — | `sep_partial` | superseded | 714 | `input/logs/09-sep2026-1.csv` | **MATCH** (bonus) |
| — | 16 × `alternate` | alternate | — | `D:\Doc\…` | **NOT_FOUND in authorized root** (out of scope; not required) |

**Primary coverage: 10 / 12 attested by SHA-256. Not a single mismatch.** Identity is established by
digest, never by filename — and the filename check is proven insufficient on its own: the June, July and
August-original digests each matched **two** paths (a root copy and the `input/logs` copy), which is why
matching on name would have been unsafe.

### 2.2 Row-count agreement

Every present export's physical row count equals the recorded `rows_used` exactly — 1,643 / 1,590 in
the expected pattern, with `nov`, `jun`, `apr`, `sep` at 1,590 and the rest at 1,643. So the file that was
hashed is the file that was actually consumed; there is no "same hash, different slice" ambiguity.

### 2.3 The two out-of-scope primaries — stated precisely

`Test-Path` returned **True** for all of:

* `D:\Doc\fingerscan\2026\Total\` (directory present)
* `D:\Doc\fingerscan\2026\Total\ai\4april.csv` (April primary, present)
* `D:\Doc\fingerscan\2026\Total\febcsv2026xlsx.xlsx` (February primary, present)

They were **not hashed**. Reading them would have been a scope expansion beyond the authorized root, and
the phase instruction is explicit: *"Stop and report if access requires privilege escalation or violates
other restrictions."* No privilege was needed, but the *location* is unauthorized, so it is reported
rather than taken.

**This is the single cheapest remaining gate:** authorizing `D:\Doc\fingerscan\2026\Total\` for hash-only
reading (no content extraction beyond the digest and row count) closes 12/12 and removes the last
evidence blocker.

---

## 3. Population 53/54 — **resolved**

### 3.1 Recomputed from primary evidence only

| Month | Distinct device codes | Rows |
|---|---:|---:|
| 2025-10 | **53** | 1,643 |
| 2025-11 | **53** | 1,590 |
| 2025-12 | **53** | 1,643 |
| 2026-01 | **53** | 1,643 |
| 2026-02 | *export not authorized* | — |
| 2026-03 | **53** | 1,643 |
| 2026-04 | *export not authorized* | — |
| 2026-05 | **53** | 1,643 |
| 2026-06 | **53** | 1,590 |
| 2026-07 | **53** | 1,643 |
| 2026-08 | **53** | 1,643 |
| 2026-09 | **53** | 1,590 |

| Measure | Value |
|---|---:|
| Union of codes across the 10 present months | **53** |
| Codes present in *every* present month | **53** (identical set) |
| Non-numeric codes | **0** |
| Master codes | **54** |
| HIP codes not in master | **0** |
| **Master codes not in HIP** | **1 — `1015`** |

### 3.2 The delta is exactly one code, and it is `1015`

The HIP population is **stable at 53 for the entire fiscal year** — no joins, no leavers, no mid-year
churn in the export set. The master's 54th code is `1015`, and `1015` is absent from **all ten** available
exports.

The triangulation that closes it:

| Evidence | `1015` |
|---|---|
| Present in 10 available primary exports | **No** (0 of 10) |
| Present in `monthly_summary.csv` | **Yes — month 2 only (February)** |
| 2027 ID-card CSV row | **None** |
| Owner-confirmed status | `ลาออก` (resigned) |
| Workbook note | "in Master, no scan found" |

So `1015`'s **single** attendance event falls in **February — one of the two months whose export is
unauthorized**. That is why it looks like "no scan" locally: the only month that would show a scan is the
one month not hash-verified. The 53/54 question is therefore **not a data discrepancy at all**; it is the
resigned person `1015` plus one unverified month.

**Grading:** delta identity **VERIFIED**. The `1015` February event itself is **UNVERIFIABLE** until the
February export is hashed.

### 3.3 Guard against the obvious trap

`events.csv` contains only late/early-leave rows (48 codes). Fifty-three minus forty-eight is **five**, and
that is *not* five missing people — it is five codes with no late or early-leave event in the year. I do
not use `events.csv` for population claims; §3.1 uses the **primary exports** only. No identity was
merged by name at any point; every comparison above is a device-code set operation.

---

## 4. SSO evidence findings

### 4.1 There are no real SSO identity records locally

| Check | Result |
|---|---|
| Database files in the V2 repo (`.sqlite`/`.db`/`.mdb`/`.ibd`/`.frm`) | **0** — only 36 `.sql` migration files |
| Seeded identity rows | `database/seeds/dev-fixtures.sql`, 3 distinct **synthetic** UUIDs, all single-character-repeated; seeds `employee_identifier`, **not** `identity_links` |
| UUID / 32-hex tokens in any `prepared/` evidence file | **0** |
| Live SSO access | **none** (forbidden by phase; not attempted) |

**Finding:** no production SSO record, and no fixture that represents a person, exists on this machine.
`employee_uid` is specified as *"the **only** canonical identity. Immutable UUID"* and explicitly must not
be *"reused, reused for a different person, or derived from an identifier"*
(`docs/IDENTITY_MAPPING_CONTRACT.md` — on the integration branch, not on `main`).

### 4.2 The "2 SSO UUID placeholder records" — two candidate origins, neither is a record

| Candidate | Shape | Why it is not the claim |
|---|---|---|
| `backend/tests/ssoMjuTokenFlow.test.js` | **2 distinct** single-character-repeated 32-char strings used as `ac` handoff codes in assertions | They are **test handoff codes**, not UUIDs and not records |
| `database/seeds/dev-fixtures.sql` | **3 distinct** synthetic all-same-character UUIDs | Count is 3, not 2; fixtures seed an identifier table, not a person registry |

The local test suite happens to contain **exactly two** distinct placeholder 32-character values, which is
the most plausible arithmetic origin of the number "2". **Grade: INFERRED, and weak.**
I record it as a plausible origin only — it is a coincidence of count, not evidence of two people.
**No UUID→person mapping was inferred, attempted or written, and no SSO identifier appears in this report.**

**Consequence:** there is nothing to reconcile and nothing to import. The claim should be withdrawn from
the recovery scope rather than carried forward as an open item.

---

## 5. Data-quality verification

### 5.1 The 21-row explanation — **VERIFIED, now from primary data**

| Group | Rows | Meaning |
|---|---:|---|
| Accepted | 12 | Acknowledged, no action |
| Reclassified as half-day leave | 9 | Report row explained by approved leave |
| **Subtotal = the "21-row discrepancy"** | **21** | Rows needing a human decision |
| Single-scan (HIP only) | 5 | HIP saw one scan, report has no row |
| **Register total** | **26** | |

All 26 register entries exist in `_build_meta.json`, and 12 + 9 = **21** exactly.

### 5.2 26 rows vs 25 unique person-months — confirmed

| Measure | Value |
|---|---:|
| Register rows | **26** |
| Distinct (month, code) pairs | **25** |
| Double-counted person-month | **`3016`, January** — classified as *both* "accepted" *and* "single-scan" |

The 21 is unaffected (accepted and reclassified do not overlap). Only the total **26** overstates the
population; it is a count of classification entries, not of people or person-months. Upstream should
quote **25** and name the double classification.

### 5.3 The derivation chain is now proven, not assumed

For every month whose primary export is available, I recomputed: *(primary late scans) − (late scans
replaced by approved half-day leave) = (`events.csv` late rows)*.

| Month | Primary late | Half-day-replaced late | Derived | `events.csv` | Δ |
|---|---:|---:|---:|---:|---:|
| 2025-10 | 145 | 1 | 144 | 144 | **0** |
| 2025-11 | 125 | 0 | 125 | 125 | **0** |
| 2025-12 | 149 | 1 | 148 | 148 | **0** |
| 2026-01 | 166 | 1 | 165 | 165 | **0** |
| 2026-03 | 159 | 2 | 157 | 157 | **0** |
| 2026-05 | 129 | 1 | 128 | 128 | **0** |
| 2026-06 | 107 | 2 | 105 | 105 | **0** |
| 2026-07 | 131 | 0 | 131 | 131 | **0** |
| 2026-08 | 118 | 1 | 117 | 117 | **0** |
| 2026-09 | 111 | 0 | 111 | 111 | **0** |
| 2026-02 | *not authorized* | 1 | — | 141 | n/a |
| 2026-04 | *not authorized* | 0 | — | 128 | n/a |

**10 / 10 available months reconcile with zero residual.** The previously unverified step — that the
derived files truly descend from the primary exports — is now demonstrated arithmetically.

### 5.4 Cross-check of the register against primary data

Eight of the nine "reclassified" rows sit in authorized months, and each reconciles as
`register + 1 half-day-replaced late scan = primary`:

| Month | Code | Register | + half-day | Primary | Verified |
|---|---|---:|---:|---:|---|
| 2025-10 | `2016` | 7 | 1 | 8 | ✅ |
| 2025-12 | `1018` | 3 | 1 | 4 | ✅ |
| 2026-03 | `1007` | 0 | 1 | 1 | ✅ |
| 2026-03 | `3016` | 6 | 1 | 7 | ✅ |
| 2026-05 | `2007` | 1 | 1 | 2 | ✅ |
| 2026-06 | `2004` | 13 | 1 | 14 | ✅ |
| 2026-06 | `3013` | 2 | 1 | 3 | ✅ |
| 2026-08 | `3044` | 1 | 1 | 2 | ✅ |
| 2026-02 | `3002` | 4 | 1 | *not authorized* | ⏳ |

**8 of 8 verifiable rows explained exactly**; the ninth is February. The reclassification taxonomy is
therefore mechanically correct, not merely plausible.

### 5.5 Totals

`events.csv` 1,624 rows = 1,600 late + 24 early; `monthly_summary.csv` sums to the same 1,600 / 24, with
11 half-day and 8 review rows. Unchanged from the previous phase and reconfirmed here.

---

## 6. ACL and Git exposure assessment

### 6.1 `prepared/` is PII-bearing and is committed

| Check | Result |
|---|---|
| Files in `prepared/` | 66 |
| **Tracked by Git** | **50** |
| Ignored by `.gitignore` inside `prepared/` | **0** — the `*.csv` rule does not cover `.json`/`.md`/`.png` |
| Tracked files containing a 4-digit-code + Thai-name pattern | **9** (4 × `*-roster.json`, `README.md`, 4 entry logs) |
| Remote | `https://github.com/numtip/Attendance-Report.git` |
| Visibility | **PRIVATE** (confirmed via `gh repo view`) |

**Assessment:** real names and a plaintext code→name table are **committed to a private repository**.
This is *contained*, not benign:

* the containment is a **single setting** (repo visibility). The V2 repo it must never touch is **public**;
* 16 files, including a `fy2568/` evidence set added after the original build, are **untracked** — so the
  tracked and on-disk sets have already diverged, and a future `git add` would silently commit more PII;
* `.gitignore` covers `*.csv` and `input/logs/` but **not** `CodexWorker/prepared/**`.

### 6.2 The primary exports themselves are correctly excluded

| Check | Result |
|---|---|
| Files tracked under `input/logs/` | **0** |
| `git check-ignore input/logs/10-Oct2025.csv` | `.gitignore:13:input/logs/` ✅ |

The 12 monthly HIP exports — the largest concentration of raw attendance PII — are **not in Git**. That
part of the posture is correct.

### 6.3 Filesystem ACL

`icacls CodexWorker\prepared`:

| Principal | Rights | Source |
|---|---|---|
| `BUILTIN\Administrators` | Full | inherited (I) |
| `NT AUTHORITY\SYSTEM` | Full | inherited |
| `Authenticated Users` | Modify, inherited to children | inherited |
| `BUILTIN\Users` | Read + execute, inherited to children | inherited |
| `CodexSandboxUsers` + 2 SID principals | Modify | inherited |

**Assessment:** every grant is inherited `(I)` — there is **no explicit restriction** on this directory.
Any local authenticated user can read the code→name table; `Authenticated Users` can also modify or
delete evidence. Recommended (not performed — read-only phase): an explicit deny/read-only ACE for the
PII-bearing subset, or move `prepared/` outside the synced project tree.

---

## 7. QA

| Gate | Result | Method |
|---|---|---|
| Independent count verification | **PASS** | all per-month counts recomputed from the 10 primary exports; not copied from the manifest |
| SHA-256 identity, not filename identity | **PASS** | 12 digests matched; 3 of them matched **two** paths each, proving name-matching alone would be wrong |
| Primary coverage | **10 / 12** | `feb`, `apr` outside authorized root; 0 mismatches |
| No duplicate identity assignments | **PASS** | 53 codes → 53 distinct people, stable every month; master∩HIP consistent; no code maps to two people |
| No silent row loss | **PASS** | every export's row count = recorded `rows_used`; 10/10 months reconcile with Δ=0 |
| No unsupported historical claims | **PASS** | 21-row and 53/54 claims now derive from primary data, not from the derived files |
| No PII or secret leakage | **PASS** | 0 names, 0 national IDs, 0 UUID values, 0 emails in this report; `.env*`/`*.key`/`*.pem` skipped unopened |
| Source provenance preserved | **PASS** | full SHA-256 for every input; master and CSV hashes unchanged before/after |
| No source modification | **PASS** | read-only opens throughout; no write handle taken on any evidence or master file |
| No person-level export | **PASS** | none created; the 11 `p25_*`/`p26_*` extracts were never opened |

---

## 8. Remaining blockers

| ID | Blocker | Impact | Closes with |
|---|---|---|---|
| **D1** | February + April primary exports are outside the authorized root (both **exist** on disk) | 2/12 unattested; `1015`'s only event and the ninth reclassified row stay unverifiable | One-line authorization for hash-only read of `D:\Doc\fingerscan\2026\Total\` |
| **D2** | The "2 SSO UUID placeholder records" claim has no evidentiary basis | Nothing to import or exclude; scope noise | Withdraw the claim, or name the artefact that produced it |
| **D3** | `prepared/` PII is tracked (50 files) in a private repo, with no ignore rule and a broad inherited ACL | Single-setting containment; future `git add` would commit more PII | Add `CodexWorker/prepared/**` handling + explicit ACL; decide retention |
| **D4** | Roster files remain unusable (0 codes, 4 byte-identical copies, all-zero counts) | No monthly staffing signal | Regenerate rosters with codes, per month |
| **D5** | `1015` workbook note "no scan found" contradicts its February event | Wrong conclusion risks being inherited later | Reword to "no scan in the 2027 card batch" |
| **D6** | Upstream quotes 26 where 25 is correct | Misleading population figure | Correct the README taxonomy |
| **D7** | Master is still not importable (name split, email, employee type, `employee_uid` policy, effective dates) | Import gate | Separate, unchanged |

**Note:** the previous phase's C1 ("the 12 primary exports are absent") is **now disproven for 10 of 12**
and withdrawn. C5 (53/54) is **closed**. C6 (codes with no attendance evidence) is **resolved**: all 54
master codes are accounted for — 53 in HIP plus `1015` in February.

---

## 9. Next gate

**Gate:** `PRIMARY_EXPORT_COMPLETION` — a single, narrow step.

1. Authorize **hash-only** reading of `D:\Doc\fingerscan\2026\Total\febcsv2026xlsx.xlsx` and
   `…\ai\4april.csv`, and verify them against the two recorded digests (`6b0c04a9…`, `64c6952d…`).
   Expected outcome: 12/12 → `ATTESTED_READY_FOR_RECOVERY_REVIEW`.
2. Answer one line: **was `1015` scanned in February?** (D5).
3. Then the recovery review can proceed on attested FY2569 evidence. Import approval remains separately
   gated on D7 and is unaffected by D1–D6.

---

## 10. Provenance of this report

* Master `docs/RAE_Employee_Roster_Update20261020.xlsx` — sha256 `eee09b83…` (unchanged).
* Reference CSV `database/IDCardRaecsv2027.csv` — sha256 `65323dff…` (unchanged).
* Evidence: 7 of 66 `prepared/` files read plus 10 primary exports hashed and parsed, all read-only.
* `D:\Doc\fingerscan\` — existence probed only; **no file opened, no hash computed**.
* No database, VPS, SSH or credential access. Nothing staged, committed or pushed.
* Supersedes the primary-export and 53/54 sections of `docs/RAE_CROSS_SOURCE_RECONCILIATION_20261020.md`;
  that report's attendance findings remain valid and are now **strengthened** by §5.3.
