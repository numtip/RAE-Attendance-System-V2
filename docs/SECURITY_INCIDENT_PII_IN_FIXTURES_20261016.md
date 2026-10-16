# Security incident: a real Thai national ID is committed in this PUBLIC repo's test fixtures

**Recorded:** 2026-10-16 (Asia/Bangkok) · **Status:** `OPEN — FILE-LEVEL FIX DONE; HISTORY STILL EXPOSED; PRIVACY-OFFICER REVIEW PENDING`
**Severity:** **HIGH / CRITICAL (public repository)** · **Found by:** adversarial QA of the R-04/R-04-C work
**Value:** masked as `****5351` throughout. **No full value appears in this document, in any commit, in any
test, or in any Agent Core call.**

> ## 🟠 THIS INCIDENT IS STILL OPEN — do not treat the redaction as closure
>
> Three of the five remediation steps are done (R2 redact, R4 guard, R5 sweep — see §5.1), and the related
> identity hardening landed 2026-10-16 (ID-6/ID-7, PR #45). **Two items remain open and are owner decisions:**
>
> * **R1 — privacy-officer review.** A ready-to-send draft is in §5.2. **Not sent.**
> * **R3 — history remediation.** The value is still retrievable from **public git history** on `origin/main`.
>   Only a rewrite + force push removes it; **not done**, and deliberately not attempted without approval.
>
> Until R3 is decided, anyone reading this repository can obtain the value.

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

## 5.1 Remediation applied on 2026-10-16 (owner-approved: "redact and guard")

| Step | Action | Evidence |
|---|---|---|
| **R2 done** | Every committed literal replaced across **6 files / 28 occurrences** — including the **dashed, Thai-digit and full-width encodings**, not just the plain ASCII form. Fixtures now use a **checksum-invalid** synthetic (`****0002`). | Post-redaction scan: no encoding of the target and no checksum-valid literal remains. Suites green. |
| **R2 done** | The one file that genuinely needed a **checksum-valid** value (`nationalIdContract.test.js` asserts the check digit) now **derives it at runtime** from a deliberately impossible prefix, so no valid literal is committed at all. | `validSyntheticNationalId()` in that file |
| **R4 done** | `backend/tests/nationalIdFixtureHygiene.test.js` — a CI guard that fails if any **canonicalizable** 13-digit literal passes the checksum. It **canonicalizes before checking**, because the original leak existed in four encodings and a `\b\d{13}\b`-only guard would have missed three of them. | 3/3 tests; the guard's own self-check asserts it actually read >100 files, so it cannot pass by scanning nothing |
| **R5 done** | Repo-wide sweep of `backend/src`, `backend/tests`, `scripts`, `docs`, `agent`: **0** checksum-valid literals remain. A second checksum-valid value found by the sweep (`****9994`, non-colliding) was also replaced with its checksum-invalid sibling. | Clean post-check |
| **R3 open** | History rewrite + force push. **Not done** — requires explicit owner approval. | — |
| **R1 open** | Privacy-officer review. Draft ready in §5.2; **not sent**. | — |

**Related hardening (2026-10-16, ID-6/ID-7, PR #45):** the identity-link layer now refuses an e-mail-shaped
or callback-`ac` subject at the link layer (not only in the SSO adapter) and refuses an unknown provenance
`source`, so a caller cannot invent provenance to escape the ambiguity guard. This is **adjacent** to this
incident — it closes the same class of "a guard that can be walked around" — but it does **not** remediate it.
The incident stays open for R1 and R3.

Two things the redaction itself proved, worth recording:

* **The guard caught its own author.** The first draft of the guard's doc comment reproduced the leaked id's
  **dashed** encoding. The guard flagged it. That is the clearest evidence the encoding coverage matters.
* **A naive mask-based guard is insufficient.** Matching `\b\d{13}\b` would have found **1 of 4** encodings
  and declared the repository clean. The guard therefore canonicalizes with the production
  `canonicalizeNationalId()` first.

**Self-disclosure:** while producing a *redacted* view of the affected files, the redaction technique used
(`\b\d{13}\b` → `<ID13>`) did **not** cover the dashed, Thai-digit or full-width forms, so those three
alternate encodings of the value were displayed in this session's working transcript. No such form was ever
written into the repository, and none appears in this document. It is recorded because a reviewer should not
have to wonder how the encodings became visible.

## 5.2 Notification (owner-approved: privacy officer first)

Draft, ready to send. It contains **no value** — the recipient must verify the id themselves.

> **Subject:** PDPA notification — a Thai national ID was exposed in a public repository
>
> **What happened.** A Thai citizen ID was used as a "synthetic" test fixture in
> `numtip/RAE-Attendance-System-V2`, which is a **public** GitHub repository. It was introduced on
> 2026-10-09 and was present on the default branch (`main`) as well as several feature branches.
>
> **How it was found.** An identity-integration audit compared identifiers in our fixtures against a real
> identifier source we are separately assessing, and found a byte-identical match (verifiable as masked
> `****5351`). A coincidence would be ~1 in 10¹³, so the fixture is assessed to be a real person's id.
>
> **Scope.** Six files, 28 occurrences, across four encodings (ASCII, hyphen-separated, Thai digits,
> full-width). The value is **not** one of the 50 employees in our onboarding scope, but it does correspond to
> a person returned by the MJU Person API. No other personal data (no name, no address) accompanied it in the
> repository, and no attendance records were exposed.
>
> **What we have already done.** Every committed literal has been replaced with a synthetic value that fails
> the Thai checksum (so it cannot be a real id), the one test that needed a valid checksum now derives it at
> runtime, and a CI guard now fails the build if any checksum-valid 13-digit literal is ever committed again.
>
> **What we have NOT done, and why we are writing.** The value remains retrievable from the **public git
> history**. Removing it requires rewriting history and force-pushing, which we have not done without
> approval. Please advise whether we should proceed, and whether the affected individual must be notified.
>
> **Asks:** (1) confirm the direction on history rewriting; (2) advise on notifying the individual;
> (3) confirm whether the MJU Person API data-protection basis requires any further step on our side.
>
> **Verification:** you can confirm the match yourself by checking whether the id ending `5351` in the cited
> files matches the id in the relevant source. We are deliberately not transmitting the full value.

## 6. See also

* `docs/IDENTITY_INTEGRATION_AUDIT.md` — the audit that produced the private source of comparison.
* `docs/IDENTITY_MAPPING_CONTRACT.md` — the contract whose whole purpose is to stop exactly this class of
  leak; its §6 controls would have prevented it.
* `docs/unified/03_SECURITY_INCIDENT_REGISTER.md` — the existing register (left untouched; it is another
  session's uncommitted WIP, so this incident is recorded here instead of editing that file).
