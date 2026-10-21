# National-ID exposure in public source — assessment and remediation plan

**Incident ID:** `PII-20261021-NID-MAIN`
**Raised:** 2026-10-21 · **Status:** **CONTAINED IN SOURCE (pending PR #60 merge) · NOT REMEDIATED IN HISTORY · NOT RESOLVED**
**Severity:** **P0** — a personal identifier is retrievable from the public repository.
**Owner decision required before any remediation step:** `S1` (see §6).

> **This document contains no identifier.** Values are described by mask (`****NNNN`), count and file only.
> Anyone producing evidence for this incident must follow the same rule: masks and counts, never a value, in any
> encoding.

---

## 1. What is exposed

| Item | Finding | Grade |
|---|---|---|
| Tracked files scanned on `origin/main` | 239 | `VERIFIED` |
| Files containing a checksum-valid 13-digit literal | **1** | `VERIFIED` |
| Distinct checksum-valid values | **2** — masks `****5351`, `****0000` | `VERIFIED` |
| File | `backend/tests/employeeIdentity.test.js` | `VERIFIED` |
| Present in current `origin/main` HEAD | **YES** | `VERIFIED` |
| Public refs carrying the file | **29** `origin/*` refs, `origin/main` among them | `VERIFIED` |
| Earliest commit containing them | `99e55b1` (2026-10-02) | `VERIFIED` |
| Earliest commit **reachable from `origin/main`** | `3244553` (2026-10-02, PR #32) | `VERIFIED` |
| Private-key or token shapes in tracked source | none | `VERIFIED` |
| Whether either value is a real person's ID | **UNKNOWN, and irrelevant to the rule** (§2) | `UNKNOWN` |

### Why "unknown" is still P0

A Thai national ID always satisfies the mod-11 checksum. A committed 13-digit literal that satisfies it is
therefore either a real person's ID or **indistinguishable from one** to every reader, auditor and attacker. The
repository's own rule treats that as a leak either way, which is why this is a P0 without first proving whose ID
it is. Trying to prove it would itself require handling the value.

### `****5351` is the previously-named leak

`AGENTS.md` states that `****5351` must never be reproduced in any encoding — plain, dashed, Thai digits or
full-width. **It is still in public `origin/main`.** That is the headline of this incident.

---

## 2. Why an earlier remediation did not fix it

Two commits on 2026-10-16 are titled *"redact a real national id from the public fixture"*: `04ff9d0` and
`850e3fc`.

**Neither is an ancestor of `origin/main`.** They were authored on other branches and never reached `main`, so the
file on `main` is unchanged. `docs/memory/PROJECT_STATE.md` records the file-level redaction (R2) as complete;
that statement is **wrong for `main`** and is corrected in this closeout.

**The lesson to keep:** a redaction is not done when the commit exists. It is done when the value is absent from
every public ref, verified by scanning the ref rather than the branch the fix was written on.

---

## 3. Containment that already exists (not yet merged)

PR **#60** (`feat/f9-national-id-hmac`) replaces all four checksum-valid literals in that file with
checksum-invalid synthetics, and adds `backend/tests/nationalIdFixtureHygiene.test.js`, which fails the build if
any checksum-valid literal is ever committed again. The guard canonicalises first, so it catches plain, dashed,
Thai-digit and full-width encodings — the four that defeated a naive `\b\d{13}\b` matcher before.

| Ref | Checksum-valid literals in that file |
|---|---|
| `origin/main` | **2** (`****5351`, `****0000`) |
| `feat/f9-national-id-hmac` | **0** |

**Merging #60 fixes `main`'s current source. It does not touch history.** A clone, a cached GitHub view, or any
commit-level fetch still retrieves the original value.

---

## 4. Remediation plan

Ordered. Each step needs the one before it. **None of steps 3–4 may be executed without owner authorisation.**

### Step 0 — do not make it worse (already in force)

- No new value enters any artefact. Reports, issues, PR bodies and logs carry masks only.
- No `git add -A`. No commit of any file under `database/local/`, `database/roster*.csv`, or any `IDCard*` file.
- No force-push, no history rewrite, no branch deletion, no stash drop. Evidence stays where it is.

### Step 1 — contain current source (available now, needs only a merge)

Merge **PR #60**. Effect: `main`'s tree becomes clean; the hygiene guard starts protecting all future commits.
**This is the one step that reduces live exposure without any risk to history.**

### Step 2 — verify containment mechanically (do this after Step 1)

Run a scan over the **ref**, not a working copy:

```
git grep -nE '(\d[ -]?){12}\d' origin/main   # then canonicalise each hit and test the checksum
```

Expected after Step 1: **0 files** with a checksum-valid literal. Record the file count scanned and the result.
A scan that reads zero files must be treated as a failure, not a pass — the guard in PR #60 already asserts this.

### Step 3 — decide on history (owner: `S1`)

Two options. Both are the owner's call; this document recommends but does not choose.

| Option | Effect | Cost | Risk |
|---|---|---|---|
| **A. Rewrite history** (`git filter-repo`), then force-push every affected ref | the value becomes unreachable from the rewritten refs | every clone is invalidated; 29 refs to reconcile; open PRs #58–#61 must be re-based or re-created; commit SHAs cited across the docs change | **high** — a rewrite keyed on the wrong commit silently leaves the value public while appearing to succeed |
| **B. Accept and contain** — leave history, rely on Steps 1–2, record a written rationale | no further exposure reduction; the value stays retrievable from history | none | **exposure persists indefinitely**; may carry notification obligations under PDPA |

**Known trap for Option A.** The value's introduction on `main` is `3244553`, **not** `83aaa53`. The 2026-10-16
incident record already warns that a rewrite keyed on `83aaa53` would leave the value public while looking
successful. Any rewrite must enumerate the introduction commit **per ref** and confirm `0` hits afterwards on
**every** rewritten ref.

**Also required for Option A:** enumerate the **29** refs that carry the file, decide the fate of each, and
preserve `stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\` outside the rewrite.

### Step 4 — notification assessment (owner + privacy officer)

Whether this triggers a PDPA notification obligation is a legal question, not a technical one. The inputs are:
the value is a national ID (if real), it was publicly retrievable, and it has been since 2026-10-02. **This
document takes no position and must not be read as advice to skip the assessment.**

### Step 5 — record the outcome

Append a dated entry to `docs/memory/DECISIONS.md` naming the option chosen and the verification performed,
including the scan result and the refs covered. **Do not mark the incident resolved on the strength of an
unmerged PR or an unverified rewrite.**

---

## 5. Prevention already added

| Control | Where | State |
|---|---|---|
| Reject a raw national ID at the storage boundary | `employeeIdentifierMariaDbRepository.insert`, fixture twin | in PR #60 |
| Store only a versioned HMAC digest, never the value | `security/nationalIdContract.js` | in PR #60 |
| Fail closed with no key — no plaintext or unkeyed fallback | `container.js`, `employeeIdentityService.js` | in PR #60 |
| Cross-version duplicate guard (DB cannot see it) | `employeeIdentityService.linkIdentifier` | in PR #60 |
| Fixture hygiene guard, four encodings, non-vacuous self-check | `nationalIdFixtureHygiene.test.js` | in PR #60 |
| Secret scanner rejects stray `.sql` | `scripts/secret-scan.mjs` | already on `main` |
| Preflight scripts provably read-only | `preflightReadOnly.test.js` | in PR #61 |

---

## 6. Decisions required

| ID | Question | Blocks |
|---|---|---|
| **S1** | Rewrite history (Option A) or accept and contain (Option B), with a written rationale. | every remediation step past Step 2 |
| **S2** | Approve merging PR #60 to contain the exposure in `main`'s source. | Step 1, and therefore Step 2 |
| **S3** | Who performs the PDPA notification assessment, and by when. | Step 4 |

**Status while these are open: `CONTAINED IN SOURCE (pending #60) · NOT REMEDIATED IN HISTORY · NOT RESOLVED`.**
