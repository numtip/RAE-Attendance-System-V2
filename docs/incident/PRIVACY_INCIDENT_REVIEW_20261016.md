# Privacy incident review — a real Thai national ID committed in a public repository

**Recorded:** 2026-10-16 (Asia/Bangkok) · **Status:** `OPEN — FILE-LEVEL FIX DONE; HISTORY STILL EXPOSED; PRIVACY-OFFICER REVIEW PENDING`
**Prepared by:** Track C (review/design) of the parallel remediation effort · **For:** authorized human review.
**Register:** [`HISTORY_REMEDIATION_OPTIONS.md`](HISTORY_REMEDIATION_OPTIONS.md) · [`HISTORY_REMEDIATION_RUNBOOK.md`](HISTORY_REMEDIATION_RUNBOOK.md) · [`DECISION_MATRIX_R1_R3.md`](DECISION_MATRIX_R1_R3.md) · [`PRIVACY_NOTIFICATION_DRAFT.md`](PRIVACY_NOTIFICATION_DRAFT.md)
**Authoritative source:** [`../SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`](../SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md) (owned by the orchestrator; not modified by this document).

> ### ⚖️ This is NOT legal advice
>
> The author of this assessment is **not a lawyer** and is not qualified to give legal advice. Every statement
> below that touches law, regulation or notification duty is **framed as a question that requires confirmation
> by the privacy officer and/or legal counsel**, never as a settled conclusion. Thai PDPA references are
> **pointers for the lawyer to confirm**, not determinations.
>
> ### 🟠 The incident is OPEN
>
> Three of five remediation steps are done (R2 redact, R4 guard, R5 sweep). **R1 (privacy-officer review) and
> R3 (history remediation) remain open and are owner decisions.** Until R3 is decided, the value is still
> obtainable from the public repository. Do not treat this document as closure.

**Label legend (used throughout `docs/unified/`):** **VERIFIED** = observed by a command run for this document, or read in the cited file · **REPORTED** = asserted in another document but not re-derived here · **UNKNOWN** = not determinable from this workspace.

**Masking convention:** the leaked identifier is `****5351`. No full value and no alternate encoding of it (dashed, Thai-digit, full-width) appears in this document, and none was read out to produce it.

---

## 1. What happened, and when

**REPORTED** (from the incident record, §1–§2 and §5.1):

A 13-digit Thai citizen ID that is **checksum-valid** and **byte-identical to a real `citizenID`** returned by the MJU Person API was used as a *"synthetic"* national-ID sample in this repository's tests. A random 13-digit value matching a specific real ID by coincidence is ~1 in 10¹³, so the working inference is that **a real person's national ID was copied into this repository as a test fixture**. The identifier's origin is a private, non-git cache in the sibling project `mju-person-enrich` (see `docs/IDENTITY_INTEGRATION_AUDIT.md` §3).

### 1.1 Timeline (what is established)

| Date | Event | Label |
|---|---|---|
| 2026-10-02 | Commit `3244553` *"Identity foundation and FaceScan raw ingestion Phase A (#32)"* — the **default-branch** commit that carries the value into `origin/main` | **VERIFIED** (this review) |
| 2026-10-09 | Commit `83aaa53` *"feat(security): single National ID crypto contract…"* — recorded as the **introducing** commit for the feature-branch chain | **REPORTED** (incident §2); carries the value on the feature chain — **VERIFIED** (this review: 11 occurrences masked `****5351` in one file at this commit) |
| 2026-10-16 | Found by adversarial QA of the R-04 / R-04-C work; incident recorded | **REPORTED** |
| 2026-10-16 | R2 (redact all committed literals), R4 (CI guard), R5 (repo-wide sweep) **done** | **REPORTED**; the redaction is a real commit — **VERIFIED** (this review: `04ff9d0` *"fix(security): redact a real national id from public fixtures and guard against recurrence"*) |
| 2026-10-16 | **R1 (privacy-officer review)** and **R3 (history remediation)** remain **open** | **VERIFIED** (branch geometry below) |

> **Correction this review adds, worth surfacing.** The incident record names `83aaa53` (2026-10-09) as the
> introducing commit. That is true of the **feature-branch chain**. On the **default branch** the value is
> present from `3244553` on **2026-10-02** — a week earlier — introduced by a different commit (`#32`).
> **VERIFIED** (this review): the value is present in `origin/main:backend/tests/employeeIdentity.test.js`, and
> `83aaa53` is **not** an ancestor of the local `origin/main`. So the public exposure on the default branch is
> **older than the recorded introduction date**, and a rewrite that keys only on `83aaa53` would miss it.

---

## 2. Blast radius as established

### 2.1 Files

| Scope | Count | Detail | Label |
|---|---|---|---|
| Files in the working tree (pre-redaction) | **6** | 5 test files + 1 doc (paths below) | **REPORTED** |
| Files still carrying the value at the **pre-redaction** commit `9511103` | **6** | measured directly, 26 occurrences of `****5351` in total | **VERIFIED** (this review) |
| Committed literal occurrences at that commit | **≥ 26** | 11 + 9 + 1 + 1 + 3 + 1 across the six files | **VERIFIED** (this review) |
| Occurrences recorded in the incident doc | **28** | the doc's number; my non-overlapping scan counts ≥ 26, so it is the same order | **REPORTED** |
| Files carrying the value on the **default branch** `origin/main` | **1** | `backend/tests/employeeIdentity.test.js` (2 occurrences, masked `****5351`) | **VERIFIED** (this review) |

Paths carrying the value (names only — the value itself is not reproduced):

* `backend/tests/nationalIdContract.test.js`
* `backend/tests/employeeIdentity.test.js` — **the one also present on `origin/main`**
* `backend/tests/dailyAttendance.test.js`
* `backend/tests/employeeAssignment.test.js`
* `backend/tests/attendanceRule.test.js`
* `docs/unified/06_SLICE1_EMPLOYEE_MASTER_AND_ATTENDANCE_FOUNDATION.md`

### 2.2 Encodings

**REPORTED:** four encodings were used (plain ASCII, hyphen-separated, Thai digits, full-width digits). That
matters because a naive `\b\d{13}\b` redaction matches only one of the four — which is exactly how the
orchestrator's earlier transcript exposure happened (incident §5.1, "self-disclosure"). The guard added in R4
canonicalizes before checking.

### 2.3 Ref reach (counts and ref names only)

**VERIFIED** (this review, read-only git):

| Metric | Count |
|---|---|
| Total refs in this clone | **58** (19 `refs/heads`, 38 `refs/remotes`, 1 `refs/stash`; 0 tags) |
| Refs containing the recorded introducing commit `83aaa53` | **24** |
| Refs containing the default-branch tip `3244553` (hence the value via `main`) | **33** |
| Refs containing the redaction commit `04ff9d0` | **5** |
| Refs that do **not** contain the redaction | **53** |

Refs containing `04ff9d0` (the only refs where the *committed* tree is already clean):

```
refs/heads/feat/identity-hardening
refs/heads/feat/slice6-reconciliation
refs/heads/feat/slice7-annual-hr-report
refs/remotes/origin/feat/identity-hardening
refs/remotes/origin/feat/slice6-reconciliation
```

Refs containing the recorded introducing commit `83aaa53` (24 — names only):

```
refs/heads/docs/daily-closeout-20261015
refs/heads/feat/agent-core-live-decisions
refs/heads/feat/identity-hardening
refs/heads/feat/secure-identifier-integration
refs/heads/feat/slice1-employee-master-foundation
refs/heads/feat/slice2-attendance-engine
refs/heads/feat/slice3-monthly-summary
refs/heads/feat/slice4-attendance-reports
refs/heads/feat/slice5-attendance-exports
refs/heads/feat/slice6-reconciliation
refs/heads/feat/slice7-annual-hr-report
refs/heads/integration/attendance-sso-hip
refs/heads/integration/sso-hip-identity
refs/remotes/origin/docs/daily-closeout-20261015
refs/remotes/origin/feat/agent-core-live-decisions
refs/remotes/origin/feat/identity-hardening
refs/remotes/origin/feat/slice1-employee-master-foundation
refs/remotes/origin/feat/slice2-attendance-engine
refs/remotes/origin/feat/slice3-monthly-summary
refs/remotes/origin/feat/slice4-attendance-reports
refs/remotes/origin/feat/slice5-attendance-exports
refs/remotes/origin/feat/slice6-reconciliation
refs/remotes/origin/integration/attendance-sso-hip
refs/remotes/origin/phase-d/sso-security-remediation
```

Commit counts (reachable commits, **VERIFIED**): all refs **151** · `origin/main` **83** · `HEAD` (`feat/slice7-annual-hr-report`) **133** · `origin/main..HEAD` **50**.

On the default branch, exactly **1 commit** touches `backend/tests/employeeIdentity.test.js` (`3244553`), so the
value entered public `main` in a single commit and was never removed there. **VERIFIED.**

### 2.4 Is it on the default branch?

**YES.** The value is present at `origin/main` (default branch) in `backend/tests/employeeIdentity.test.js`.
**VERIFIED** (this review; the incident doc's "1 file on `origin/main`" is confirmed). This is the fact that
makes the exposure public rather than internal.

---

## 3. Affected data subject class

| Question | Answer | Label |
|---|---|---|
| Is the value one of RAE's 50 in-scope employees? | **NO** — a membership-only test against the protected scope CSV returned negative | **REPORTED** (incident §2). *Not re-run by this review and deliberately not re-run.* |
| Is it a real person's identifier? | It is **checksum-valid** and **byte-identical to a `citizenID` cached from the MJU Person API**. A coincidence is ~1 in 10¹³, so it is **assessed** to be a real person's id. This is a **strong inference, not a formal proof of identity binding.** | **REPORTED** + assessed |
| Whose data is it? | A person returned by the MJU Person API — i.e. someone in MJU's data sphere. Whether that person is a current/former employee, student or otherwise is **UNKNOWN** from this workspace. | **UNKNOWN** |
| What did NOT leak with it? | No name, address, e-mail, photo or attendance record accompanied the value in the repository. Only the raw 13-digit number, in test fixtures and one doc. | **REPORTED** |
| Does "not in RAE scope" reduce the harm? | It reduces **RAE's** internal scope mismatch, but a real individual is still identifiable by a high-value identifier that is publicly reachable. It must not be read as "no subject, no duty". | Assessment |

**What would resolve the open questions:** a data-protection review of the MJU Person API's provenance and
lawful basis (owner + privacy officer) — linked to **G7** in `docs/IDENTITY_MAPPING_CONTRACT.md` (§6.1) and to
`docs/IDENTITY_INTEGRATION_AUDIT.md` §0.2 / F12.

---

## 4. Is the value still reachable, and how easily?

| Question | Answer | Label |
|---|---|---|
| Reachable from the repository now? | **YES** — from `origin/main` history. The working tree is redacted, but the blob is reachable through the default branch's history. | **VERIFIED** |
| How easily? | A reader of the **public** repository needs only a clone or the GitHub UI; no special access. There is also a **GitHub Pages deploy** (incident §3). | REPORTED (Pages) / VERIFIED (public + reachable) |
| Is a clone already held elsewhere? | **UNKNOWN.** A public repo can have been cloned, forked, archived or scraped by anyone, at any time since 2026-10-02. Nothing in this workspace can enumerate that. | **UNKNOWN** |
| Has anyone actually retrieved it? | **UNKNOWN.** No access telemetry exists for this workspace; GitHub clone/fork counts are not available here. | **UNKNOWN** |
| GitHub's own retention (PR refs, GC, cached views, API blobs)? | **UNKNOWN** and depends on GitHub internals. A rewrite of *our* refs does not by itself prove the value is gone from GitHub-side caches or from `refs/pull/*`. | **UNKNOWN** |
| Would deleting the file in a new commit help? | **NO.** The blob stays reachable through history; a later commit removes it from the tip only. See `HISTORY_REMEDIATION_OPTIONS.md` §"What does NOT work". | Assessment |

**What would resolve it:** (a) GitHub-side fork/clone/network telemetry, which the owner may be able to see in
the repo's Insights/Network; (b) a secret/PII scanning provider with history coverage; (c) an explicit statement
from each collaborator about historic clones. None of these is available from this workspace.

---

## 5. Legal and regulatory frame — REQUIRES HUMAN / LEGAL CONFIRMATION

> **Not legal advice.** The items below are **questions for the privacy officer / legal counsel**, each with the
> facts a lawyer would need. Nothing here is a determination, a required action, or a deadline.

Facts a reviewer needs (all **VERIFIED** or **REPORTED** above):

1. A real, checksum-valid Thai citizen ID — a direct identifier — was published in a **public** GitHub repository
   from **2026-10-02** (default branch) and remained in history through 2026-10-16 at least.
2. It is **still retrievable** from the default branch's history today; the redaction is not in `main`.
3. The person is **not** in RAE's onboarding scope, and **no other personal data** accompanied the value.
4. A sibling private project holds **303 plaintext national IDs at rest** on a non-git disk with no history and
   no access log (`PROJECT_STATE.md` R10, `IDENTITY_INTEGRATION_AUDIT.md` §3) — an adjacent exposure the
   privacy officer may wish to consider in the same review.

Questions for the privacy officer / legal (**open — do not treat as answered**):

| # | Question | Pointer for the reviewer |
|---|---|---|
| L1 | Does Thai **PDPA** treat this as a personal-data breach requiring a formal assessment, and does it trigger the "high risk" notification pathway? | requires confirmation — the obligation wording, thresholds and timelines must come from counsel |
| L2 | What notification timeline and form apply, **if** any, given the exposure is public and ongoing? | requires confirmation |
| L3 | Is the controlling data controller RAE, MJU, or both (the data came from an MJU-provided API)? | requires confirmation |
| L4 | Does the internal rule violated (see §6.1) create an additional internal-reporting duty? | requires confirmation |
| L5 | Is there a **data-protection basis** for RAE receiving `citizenID` from the MJU Person API **at all**? | **G7**, `docs/IDENTITY_MAPPING_CONTRACT.md` §6.1; `docs/IDENTITY_INTEGRATION_AUDIT.md` F12 — needs a completed **DPIA + privacy-officer sign-off** |
| L6 | Does the adjacent `mju-person-enrich` store (303 plaintext ids, unhashed, non-git) require its own assessment or remedial order? | `PROJECT_STATE.md` R10 |

The internal rules that were breached (a fact, not a legal conclusion) — **VERIFIED**:

* `AGENTS.md`: *"Never put PII, secrets, National IDs (mask as `****NNNN`) or CSV content into code, docs, logs, commits or PR text."*
* `docs/NATIONAL_ID_PROTECTION_POLICY.md`: *"no plaintext in DB, no raw ID in logs, PRs, test output, or reports"* — and the very contract commit `83aaa53` introduced was defeated in its own tests.

---

## 6. Already mitigated vs still exposed

| Item | State | Evidence / label |
|---|---|---|
| **R2 — committed literals replaced** across 6 files / 28 occurrences (incl. dashed, Thai, full-width) | **DONE** | **REPORTED**; **VERIFIED** by this review: at `HEAD` (`feat/slice7-annual-hr-report`) the affected files contain **0** checksum-valid literals |
| **R2 — the one file needing a valid checksum now derives it at runtime** | **DONE** | REPORTED |
| **R4 — CI guard** `backend/tests/nationalIdFixtureHygiene.test.js` that fails on any checksum-valid committed literal, canonicalizing first | **DONE** | EXISTS on this branch; **VERIFIED** (read) |
| **R5 — repo-wide sweep** of `backend/src`, `backend/tests`, `scripts`, `docs`, `agent` → 0 checksum-valid literals | **DONE** | REPORTED |
| Redaction **committed** (`04ff9d0`) | **DONE**, but only on **5 of 58 refs** | **VERIFIED** (this review) |
| **R3 — history rewrite + force push** | **NOT DONE — deliberately** | **VERIFIED**: the value is present in `origin/main` history |
| **R1 — privacy-officer review / notification decision** | **NOT DONE** | REPORTED; see `PRIVACY_NOTIFICATION_DRAFT.md` |
| The value on the **public default branch** | **STILL EXPOSED** | **VERIFIED** |
| Any existing clone, fork, scrape, GitHub-side cache | **UNKNOWN — assume reachable** | **UNKNOWN** |
| Adjacent `mju-person-enrich` 303-plaintext-id store | **UNCHANGED** (out of this incident's scope, same class) | REPORTED (`PROJECT_STATE.md` R10) |

**Net position:** the *working tree* is clean and guarded; **the public history is not.** Anyone can still obtain
the value from the default branch today. That is the whole of what R3 addresses, and R3 has not been run.

---

## 7. What this review could NOT determine

| Gap | Why | What would resolve it |
|---|---|---|
| Whether anyone cloned/forks/scraped the repo | no telemetry in this workspace | GitHub Insights/Network; vendor scanning; collaborator statements |
| Whether GitHub retains the blob after a rewrite | GitHub-internal | GitHub documentation/support; post-rewrite verification of `refs/pull/*` and cached views |
| Whether the person is identifiable beyond the id | no name/context in the repo | MJU-side records; privacy-officer determination |
| The exact legal characterisation and any duty to notify | **not a legal question for this review** | privacy officer / legal counsel |
| Whether the value appears in **other** repositories or agent stores on this machine or under the same account | out of scope for a read-only git review; searching broadly for a 13-digit value risks re-exposing it | a masked, canonicalizing scanner run under controlled conditions, reporting counts only |
| The true full count of occurrences in history | git history is large; this review scanned the six named files at one commit | a masked, canonicalizing scan of every commit's tree, reporting counts only |

---

## 8. Recommendation (advisory — the owner decides)

1. **Treat the incident as OPEN and public.** The mitigation to date is a doorway lock with the window still open.
2. **Put `HISTORY_REMEDIATION_OPTIONS.md` in front of the owner**, not a single tool name. The tool choice is
   secondary to the decision to rewrite at all.
3. **Do not run a rewrite before the pre-flight in `HISTORY_REMEDIATION_RUNBOOK.md`** — a mirror backup that has
   been restore-tested, a frozen window and informed collaborators come first.
4. **Separate the two decisions** (see `DECISION_MATRIX_R1_R3.md`): notification (R1) and remediation (R3) are
   independent; R1 can proceed without R3 and vice versa.
5. **Do not treat "make the repository private" as remediation.** It limits *future* readers; it does not
   un-expose anything already cloned, forked or indexed. It may be a useful *containment* step, not a fix.
6. **Route every legal statement to the privacy officer.** This document is an input to that review, not its
   conclusion.

**This document changes nothing and closes nothing.** The incident remains `OPEN` for **R1** and **R3**.
