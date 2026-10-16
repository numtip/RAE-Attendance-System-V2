# Security incident: a real Thai national ID is committed in this PUBLIC repo's test fixtures

**Recorded:** 2026-10-16 (Asia/Bangkok) · **Status:** `REPORTED — AWAITING OWNER DECISION, NOT REMEDIATED`
**Severity:** **HIGH / CRITICAL (public repository)** · **Found by:** adversarial QA of the R-04/R-04-C work
**Value:** masked as `****5351` throughout. **No full value appears in this document, in any commit, in any
test, or in any Agent Core call.**

> ## ⚠️ DO NOT "FIX" THIS BY EDITING THE FILES ALONE
>
> The value is in **`origin/main`** and therefore on a **public GitHub repository**, and it is in the
> **commit history**. Editing the working tree does not remove it. The real decision is
> **(a) history rewrite + force push** (currently **forbidden** without explicit owner approval) and
> **(b) whether anyone must be notified**. See §4.

---

## 1. What was found

A **checksum-valid** 13-digit Thai citizen ID (masked `****5351`) is used as a *"synthetic"* national-ID
sample in this repository's tests. It is **byte-identical to a real `citizenID`** returned by the MJU Person
API and cached in the sibling private project `G:\ProjectAI\mju-person-enrich\logs\person-cache.json`.

A 13-digit value matching a specific real ID by coincidence is ~1 in 10^13. **The inference is that a real
person's national ID was copied into this repository as a test fixture.**

## 2. Verified scope (independently re-verified by the orchestrator)

| Check | Result |
|---|---|
| Checksum-valid? | **yes** (`isValidNationalIdChecksum`) |
| Collides with a real cached `citizenID`? | **yes** — 1 of 303 distinct ids in the private MJU cache |
| Distinct 13-digit constants in the repo | 21 · of which checksum-valid **2** · of which colliding **1** |
| The other checksum-valid constant (`****9994`) | **does not collide** — genuinely synthetic |
| Files in the working tree | **6** |
| Present on `origin/main`? | **YES** (1 file) — so it is already public on the default branch |
| Present on `HEAD` / feature branches? | **yes** (`HEAD`, `feat/slice5-…` 6 files; `integration/attendance-sso-hip` 2) |
| Introduced by | commit `83aaa53`, **2026-10-09**, *"feat(security): single National ID crypto contract shared by backend, onboarding scripts and resolver"* — **pre-existing, not introduced by the R-03/R-04/R-04-C work** |
| Is it one of RAE's 50 in-scope employees? | **NO** — a membership-only test against `database/IDCardRaecsv2027.csv` returned negative |

Files carrying it (paths only; the value is not reproduced):

* `backend/tests/nationalIdContract.test.js`
* `backend/tests/employeeIdentity.test.js`
* `backend/tests/dailyAttendance.test.js`
* `backend/tests/employeeAssignment.test.js`
* `backend/tests/attendanceRule.test.js`
* `docs/unified/06_SLICE1_EMPLOYEE_MASTER_AND_ATTENDANCE_FOUNDATION.md`

> **Note on method:** the membership test read the protected CSV **without printing, copying or editing any
> value**, and returned a boolean only. It was performed because scope membership materially changes the
> incident's assessments. No value from that file was read out.

## 3. Why this matters even though it is "only a test"

* `AGENTS.md` states plainly: *"Never put PII, secrets, National IDs (mask as `****NNNN`) or CSV content into
  code, docs, logs, commits or PR text."* This violates that rule in a **public** repository.
* `docs/NATIONAL_ID_PROTECTION_POLICY.md` promises *"no plaintext in DB, no raw ID in logs, PRs, test output,
  or reports"*. The protection contract that commit `83aaa53` introduced is itself defeated in its own tests.
* A national ID is a high-value identifier for identity fraud, and this repository is **public** and has a
  **GitHub Pages deploy**.
* The affected person is **not** an in-scope RAE employee, which limits RAE's own exposure — but it is still a
  real, identifiable individual, and Thai **PDPA** obligations attach to the data regardless of internal scope.

## 4. Why nothing was changed (deliberate)

1. **Editing the files would create a false sense of resolution.** The value stays retrievable from history on
   a public remote. A redaction of the working tree alone is cosmetic for this threat.
2. **Removing it from history requires a history rewrite and a force push**, which the standing governance
   forbids without explicit owner approval (and which is disruptive across the stacked PR chain).
3. **Notification is a human/legal decision**, not an engineering one.
4. The instruction for the work that surfaced this was explicit: *report immediately, do not fix silently.*

## 5. Recommended remediation, in order

| # | Action | Owner | Note |
|---|---|---|---|
| R1 | **Decide the notification question** (affected person and/or privacy officer). | owner + privacy officer | The person is not an RAE employee; the data came from the MJU Person API. |
| R2 | **Replace the constant** in all 6 files with a value that is **provably synthetic** — i.e. absent from every external source (e.g. an obviously-fake pattern, or one validated against the cache and the protected CSV). | engineering | Cheap; do it as its own focused change, not folded into unrelated work. |
| R3 | **Rewrite history + force push**, or **accept** the exposure and document why. | owner | Only R3 actually removes the leak. Forbidden without explicit approval. |
| R4 | **Add a guard so this cannot recur**: a test/CI check that every checksum-valid 13-digit constant in the repo is absent from any known external id source, and/or a rule that fixtures must not use checksum-valid ids at all. | engineering | This is the durable fix. |
| R5 | **Audit the same pattern repo-wide** — the QA pass found 21 distinct 13-digit constants (72 occurrences) and 8 `rawCitizenID`-shaped hits; only 1 collides today, but the pattern is systemic. | engineering | Cheap, high value. |

**Recommended immediate position:** do **R2** and **R4/R5** once the owner agrees, and treat **R1/R3** as
owner decisions. Until R3 happens, anyone reading this repository can obtain the value.

## 6. See also

* `docs/IDENTITY_INTEGRATION_AUDIT.md` — the audit that produced the private source of comparison.
* `docs/IDENTITY_MAPPING_CONTRACT.md` — the contract whose whole purpose is to stop exactly this class of
  leak; its §6 controls would have prevented it.
* `docs/unified/03_SECURITY_INCIDENT_REGISTER.md` — the existing register (left untouched; it is another
  session's uncommitted WIP, so this incident is recorded here instead of editing that file).
