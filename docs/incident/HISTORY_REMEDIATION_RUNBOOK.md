# History remediation runbook — PRECONDITIONED, DO NOT RUN WITHOUT EXPLICIT OWNER APPROVAL

> # 🛑 DO NOT RUN THIS WITHOUT EXPLICIT OWNER APPROVAL
>
> **Neither the Track C authors nor the orchestrator has run this procedure. No step in it has been executed.
> No branch, tag, ref or object has been rewritten, deleted or pushed.** This is a *plan* for a human
> operator, to be used only after the owner has approved option **(b) `git filter-repo` on a fresh mirror
> clone** in
> [`HISTORY_REMEDIATION_OPTIONS.md`](HISTORY_REMEDIATION_OPTIONS.md) and signed off in
> [`DECISION_MATRIX_R1_R3.md`](DECISION_MATRIX_R1_R3.md).
>
> **A history rewrite is irreversible in practice.** If the pre-flight is not complete, stop.
>
> **No identifier value appears in this runbook, in any encoding.** Where a value must be supplied, the operator
> supplies it into a **local, temporary, never-committed** file they control (§3 step P6), and destroys it after.

**Status:** `PLAN ONLY — NOT EXECUTED` · **Owner of execution:** a named human operator · **Prepared:** 2026-10-16.

---

## 0. Scope and non-goals

| | |
|---|---|
| **Goal** | Make the leaked identifier unreachable in the **public remote's** history, on **every** ref. |
| **Tool of record** | `git filter-repo` on a **fresh mirror clone** (§2). |
| **Not in scope** | Notification (R1 — see `PRIVACY_NOTIFICATION_DRAFT.md`); the adjacent `mju-person-enrich` store; any application code change. |
| **Explicitly out of scope / forbidden here** | running anything in *this* workspace that rewrites refs; `git gc`/`prune`/`repack` in this workspace; deleting `stash@{0}`/`stash@{1}`; touching `G:\ProjectAI\_backups\`. |

### 0.1 Why a *fresh mirror clone*, and not this workspace

The rewrite must not disturb this workspace, because `AGENTS.md` pins `stash@{0}`, `stash@{1}` and the
`_backups` directory. `git filter-repo` also refuses to run on a repository with a dirty working tree or
stashes by default, and its own guidance is to run on a fresh clone. Working in a separate mirror clone makes
C2/C3 preservation automatic rather than hopeful.

---

## 1. PRE-FLIGHT CHECKLIST (all must be TRUE before any rewrite)

Every line must be **ticked, named and evidenced** before step 2. If any is FALSE or UNKNOWN, **stop**.

| # | Requirement | Who confirms | Evidence to attach | Done |
|---|---|---|---|---|
| P1 | **Owner approval** of option (b), in writing, with a date and a signature/comment. | Owner | link/quote in the decision matrix | ☐ |
| P2 | **Privacy-officer direction** recorded (they may require a different order or a hold). | Privacy officer | note in `DECISION_MATRIX_R1_R3.md` | ☐ |
| P3 | **Branch-protection exception** approved (the default branch will need a force-push), logged. | Repo admin | settings screenshot / note | ☐ |
| P4 | **Frozen window** agreed: no other pushes to any branch/tag during the rewrite and push. | All collaborators | message timestamps | ☐ |
| P5 | **Every collaborator informed** that they must discard their clones and re-clone after, and must not push old history. | Owner / operator | recipient list | ☐ |
| P6 | **A local, temporary "expurge" source prepared** that lets the tool find **all four encodings** of the value without a copy of the value being committed or logged. It must not be added to any repo, and it must be destroyed in step 5. | Operator | procedure note only — **never its contents** | ☐ |
| P7 | **Full mirror backup taken** (§2 step 1) **and restore-verified** (§2 step 2). Not "copied" — *verified by restoring*. | Operator | restore-test output | ☐ |
| P8 | **Exact ref list to rewrite** enumerated and agreed (§1.1). | Operator + owner | the list below | ☐ |
| P9 | **`stash@{0}` and `stash@{1}` confirmed present** in this workspace. | Operator | `git stash list` (2 entries) | ☐ |
| P10 | **`G:\ProjectAI\_backups\main-uncommitted-20261009` confirmed present.** | Operator | directory listing | ☐ |
| P11 | **CI known-green baseline** on the branches to be preserved, so a post-rewrite red is attributable. | Operator | CI status | ☐ |
| P12 | **The PR-stack outcome decided in writing for the six stacked Draft PRs #41–#46**: re-create the stack against the rewritten refs, or accept its loss. | Owner | decision matrix row (D2) | ☐ |
| P12b | **The #41–#46 stack has been enumerated and each PR's base/head recorded** before the rewrite, so the operator can confirm after the push which PRs were auto-closed and which need re-creating/retargeting. | Operator | list of PR base/head refs | ☐ |
| P13 | **A second, independent copy of the mirror backup on different media.** | Operator | path | ☐ |

### 1.1 Refs in scope (the ref set to verify after, from this review)

The value is present at **35 of 60 refs** in this clone — every ref that contains `3244553` (the default-branch
tip, and the commit that introduced the value on `main`). The rewrite must cover, at minimum, **all branch
refs and tags**, and the operator must confirm the remote's `main` plus every `feat/*` / `integration/*` /
`docs/*` ref. The 26 refs containing the feature-chain commit `83aaa53` are enumerated in
[`PRIVACY_INCIDENT_REVIEW_20261016.md`](PRIVACY_INCIDENT_REVIEW_20261016.md) §2.3 — but note that
**`83aaa53` is not the main introduction commit and is not an ancestor of `origin/main`**; the rewrite target
is `3244553` and every ref that carries it. **UNKNOWN:** whether GitHub's `refs/pull/*` refs also serve the
value; that must be checked, not assumed.

> **Note for the operator:** the default branch matters most. `main` carries the value in
> `backend/tests/employeeIdentity.test.js` from commit `3244553` (2026-10-02) — **not** from `83aaa53`. A
> rewrite targeting only the recorded introducing commit will **miss the default branch**.

---

## 2. THE PROCEDURE (per option b)

> **All commands below are for the OPERATOR, in a terminal, after P1–P13 are complete.** `git.exe` on Windows
> per `AGENTS.md`. Nothing here is run by this track. `<ANGLED>` items are placeholders.

### Step 1 — take the mirror backup (does not touch this workspace)

```powershell
# A fresh, complete mirror of the remote — this is the rollback source.
git.exe clone --mirror https://github.com/numtip/RAE-Attendance-System-V2.git <MIRROR_BACKUP_DIR>
# Also record exactly what you backed up:
git.exe -C <MIRROR_BACKUP_DIR> rev-parse --all
git.exe -C <MIRROR_BACKUP_DIR> for-each-ref --format="%(refname) %(objectname)"
```

### Step 2 — VERIFY the backup by restoring it

```powershell
git.exe clone --mirror <MIRROR_BACKUP_DIR> <RESTORE_TEST_DIR>
git.exe -C <RESTORE_TEST_DIR> fsck
# Confirm the restore test reproduces the same ref list as step 1.
```
Only continue when the restored ref list matches. **Do not proceed on an unverified backup.**

### Step 3 — work on a *second* mirror clone, never the backup

```powershell
git.exe clone --mirror <MIRROR_BACKUP_DIR> <WORK_DIR>
cd <WORK_DIR>
```

### Step 4 — rewrite the history (dry-run first)

`git filter-repo` supports a dry run. Run it, read the plan, and only then run for real.

```powershell
# Replace every encoding of the value using the local expurge file from P6.
#   <EXPURGE_FILE> uses filter-repo's --replace-text format, one expression per line.
#   It MUST cover plain, hyphen-separated, Thai-digit and full-width forms, or the rewrite is incomplete.
git.exe filter-repo --replace-text <EXPURGE_FILE> --dry-run
# If and only if the dry run looks correct:
git.exe filter-repo --replace-text <EXPURGE_FILE>
```

> **Encoding trap (from this incident's own post-mortem):** a rewrite that handles only the plain ASCII form
> leaves three of four encodings behind, and a matcher of the shape `\b\d{13}\b` would report "clean" while the
> dashed/Thai/full-width forms survive. The expurge expressions and the verification in step 6 must
> **canonicalize** — exactly as `backend/tests/nationalIdFixtureHygiene.test.js` does.

### Step 5 — verify on the WORK clone BEFORE pushing (counts only, never print matches)

Run a **canonicalizing** scan over *every ref* of `<WORK_DIR>`, reporting **counts and masked forms only**
(`****5351`). A practical form:

```powershell
git.exe -C <WORK_DIR> for-each-ref --format="%(refname)"
# For each ref, extract every tree and scan for checksum-valid 13-digit literals using the repo's own
# canonicalizer (backend/src/security/nationalIdContract.js), printing COUNTS ONLY.
```

Acceptance for step 5: **the count of occurrences of `****5351` is ZERO at every ref**, and no
checksum-valid literal remains in the affected paths.

**Destroy the expurge file from P6 now** (and make sure it was never inside a git repository and never entered
a shell history or a log).

### Step 6 — push (the irreversible step)

```powershell
cd <WORK_DIR>
# Force-push every rewritten ref. Enumerate them explicitly; do not rely on a single wildcard you have not listed.
git.exe push --force <REMOTE> <REF1> <REF2> ... <REFN>
# Tags, if any (this clone currently has 0 tags — VERIFIED, so likely none):
git.exe push --force --tags <REMOTE>
```

### Step 7 — verify on the REMOTE, not just the local work clone

```powershell
# Re-mirror the remote and re-run the canonicalizing scan from step 5 against the re-mirrored clone.
# Then explicitly probe refs/pull/* if the platform exposes them.
```
Acceptance for step 7: **zero** occurrences of `****5351` at every ref that the remote actually serves.

### Step 8 — restore this workspace

```powershell
# In THIS workspace (the project folder) — a fetch/reset only; no rewrite here.
git.exe fetch --prune <REMOTE>
git.exe status -sb
```
Then re-clone fresh, or `git reset --hard` onto the rewritten refs, and confirm:
`git stash list` still shows **2 stashes**, and `G:\ProjectAI\_backups\` is unchanged.

---

## 3. POST-VERIFICATION CRITERIA (all must hold)

| # | Criterion | How it is proven | Done |
|---|---|---|---|
| V1 | The value is **absent at EVERY ref** of the remote — union over branch refs, tags, and `refs/pull/*` if reachable. The masked form `****5351` must not occur in any blob at any ref, in **any of the four encodings** (plain, dashed, Thai-digit, full-width). | canonicalizing scan on a fresh re-mirror, **counts only** | ☐ |
| V2 | No checksum-valid 13-digit literal remains in the affected files at any ref. | the R4 guard's logic applied to each ref's tree | ☐ |
| V3 | The **working tree** of this workspace equals a clean, redacted state (as it is today). | `git status`, spot file reads | ☐ |
| V4 | **`stash@{0}` and `stash@{1}` still exist** and are unchanged. | `git stash list` | ☐ |
| V5 | **`G:\ProjectAI\_backups\main-uncommitted-20261009`** is present and untouched. | directory listing | ☐ |
| V6 | **CI is green** on the preserved branches. | CI | ☐ |
| V7 | The **six stacked Draft PRs (#41–#46)** are either **re-created** against the rewritten refs, or their loss is **accepted in writing** by the owner. | decision matrix | ☐ |
| V8 | Every collaborator has **re-cloned**, and none holds a clone that can push the old history back. | acknowledgements | ☐ |
| V9 | The mirror backup and its second copy are **retained** (not deleted) for the agreed retention period. | paths | ☐ |
| V10 | The incident record is updated to "R3 done" **only after V1–V9** — never on the strength of the push alone. | incident file | ☐ |

---

## 4. ROLLBACK

Rollback is possible **only** from the verified mirror backup, and its feasibility degrades once old objects
expire server-side or collaborators have moved on. **Decide before you push whether rollback is still on the
table; after a period of time it will not be.**

```powershell
# Nuclear rollback: restore the pre-rewrite refs from the verified mirror backup.
cd <MIRROR_BACKUP_DIR>
git.exe push --force <REMOTE> "refs/*:refs/*"
```

| Rollback scenario | Procedure | Caveat |
|---|---|---|
| Something is wrong **before** any push | Discard `<WORK_DIR>`; the backup is untouched. | Trivial. |
| Wrong/failed push, old refs still on the remote | Restore from `<MIRROR_BACKUP_DIR>` with the command above. | Requires the protection exception still in place. |
| Need to roll back **after** collaborators re-cloned | Notify everyone; they must re-clone **again**. | High coordination cost. |
| Old objects already expired / server GC'd | Rollback may be impossible. | **Golden rule: keep the mirror backup until V1–V9 pass and the incident is closed.** |

**Rolling back re-introduces the public exposure.** A rollback is only correct if the rewrite itself was faulty,
not because the exposure is unwelcome.

---

## 5. Failure modes and stop conditions

**STOP immediately and re-assess if any of these occurs:**

* The dry run (step 4) reports changes you did not expect, or expects no changes.
* The step-5 scan finds **any** occurrence of `****5351` remaining in `<WORK_DIR>`.
* A ref cannot be enumerated or verified (an "unverifiable ref" must be treated as exposed, not as clean).
* `refs/pull/*` still serves the value after step 6.
* `git stash list` no longer shows 2 entries, or `G:\ProjectAI\_backups\` changed.
* CI goes red on a branch you did not touch.
* A collaborator pushes old history during or after the frozen window.

---

## 6. What this runbook deliberately does NOT do

* It does not send or authorise any notification (that is R1, `PRIVACY_NOTIFICATION_DRAFT.md`).
* It does not close the incident — the incident record is updated only when V1–V10 all hold.
* It does not touch the adjacent `mju-person-enrich` store.
* It does not run any step in this workspace that rewrites refs, and it forbids `git gc`/`prune`/`repack` here.

**Nothing in this runbook has been executed. The incident remains `OPEN` for R1 and R3.**
