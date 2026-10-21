# Owner questions

Effective 2026-10-20, extended 2026-10-21. Q1–Q3 were **RESOLVED_BY_OWNER** on 2026-10-19; their evidence stays
below the decision and their counts are unchanged.

**2026-10-21 additions:** `S1`, `S2`, `S3` (P0 incident) and `M1` (migration integration). These are **new and
unanswered**. Nothing in this file may be answered by invention — see the standing rule at the bottom.

---

## P0 incident — 2026-10-21

Context: [`../security/NATIONAL_ID_INCIDENT_20261021.md`](../security/NATIONAL_ID_INCIDENT_20261021.md).

| ID | Question | Blocks | Status |
|---|---|---|---|
| **S1** | History remediation: **rewrite** with `git filter-repo`, or **accept-and-contain** with a written rationale? | every remediation step past verification | **OPEN** |
| **S2** | Approve merging **PR #60** to remove the value from `main`'s **source** and add the hygiene guard. | containing the source exposure | **OPEN** |
| **S3** | Who performs the PDPA notification assessment, and by when? | the notification decision | **OPEN** |

### S1 — the choice, with its costs

| Option | Effect | Cost | Risk |
|---|---|---|---|
| **A. Rewrite history**, then force-push every affected ref | value unreachable from the rewritten refs | every clone invalidated; **29** refs to reconcile; open PRs #58–#61 re-based or re-created; every SHA cited in the docs changes | **high** — a rewrite keyed on the wrong commit leaves the value public while appearing to succeed |
| **B. Accept and contain** — leave history, rely on #60 + verification, record a rationale | no further exposure reduction | none | exposure persists; possible PDPA obligation |

**If A:** the introduction commit on `main` is **`3244553`**, not `83aaa53`. Enumerate the introduction commit
**per ref**, rewrite, then confirm **0** checksum-valid literals on **every** rewritten ref. Preserve
`stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` outside the rewrite.

**If B:** state in writing that the exposure is accepted, and record the residual risk so a later session does not
discover it as new.

---

## Migration integration — 2026-10-21

| ID | Question | Blocks | Status |
|---|---|---|---|
| **M1** | Approve the integration order (`#58 → #60 → #59 → #61`, or `#60` first), **and** decide the fate of `015_facescan_hip_ingestion`'s `DROP` of `014`'s staging tables. | applying #61 to any populated database | **OPEN** |

`015_facescan` irreversibly drops `staging_facescan_raw` and `facescan_import_batches` and re-creates them with
different column names; `main`'s `facescanRawMariaDbRepository` still selects the old names. The options are: accept
the loss because the tables are empty pre-production; migrate the rows first; or amend the migration (which is a
schema redesign and needs its own review). **The repository's rule "never rename an applied migration" means these
are the only options.**

---

## Carried forward — still blocking the import

These predate this file's 2026-10-21 extension and remain unanswered. **0 of 54 import rows are ready.**

| ID | Question | Rows blocked |
|---|---|---|
| **O-4** | Confirm the roster's `name` is the given name and `c_name` the family name. | F2, 5 rows |
| **O-5** | Which spelling is current for code `2017`? | 1 row |
| **O-6 / F5** | Supply a verified `effective_from` per person, or approve a documented placeholder policy. | **all 54** |
| **O-7 / F6** | Owner-confirmed names for `1013` and `1015`. | 2 rows |
| **O-8 / F9** | Approve the national-ID path end-to-end (the HMAC contract is in PR #60, unmerged). | global |
| **O-9 / R-F4a** | Approve `027` after disposable-MariaDB evidence. Still proposal-only. | schema hardening |
| **F10** | May the HIP code serve as `employee_id` for `1015`, or must a code be supplied? | 1 row |

**Carried and unresolved, not answerable from the roster:** the 19-code `dataperson.csv` exclusion
(D-2026-10-20-09) and the 24/25/26 discrepancy counts (D-2026-10-20-08).

---

## Resolved (kept for the evidence trail)

| ID | Decision |
|---|---|
| Q1 | **EXCLUDE** the 19 codes that are not in the identity master. |
| Q2 | **KEEP QUARANTINED** the 5 name-mismatch events. No automatic mapping. |
| Q3 | **ACCEPT 24** person-months evidenced by the source file. Do not fabricate the missing 2. |
| O-1/O-2 | Roster is authoritative for its 49 records; the import is **additive** over all 54; absence is **not** resignation. (`D-2026-10-21-02`) |
| O-3 | **PROVEN** — the apparently code-less workbook row **is** code `1015`. (`D-2026-10-21-03`) |

---

## Standing rule

No question in this file is answered by an agent. If evidence is missing, the answer is **"blocked, here is what
would settle it"** — never a plausible value. The three ways this has gone wrong before: a fabricated employment
date, a guessed name split, and a derived `employee_uid`. All three are now enforced in code.
