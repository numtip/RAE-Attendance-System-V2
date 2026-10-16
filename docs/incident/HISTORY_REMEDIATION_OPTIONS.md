# History remediation options — removing the leaked identifier from git history

**Status:** `OPEN — OPTIONS FOR OWNER DECISION. NOTHING HERE HAS BEEN RUN.`
**Prepared:** 2026-10-16 (Asia/Bangkok) · **Owner of the decision:** repository owner (with privacy officer on the notification question).
**Companion:** the preconditioned procedure is [`HISTORY_REMEDIATION_RUNBOOK.md`](HISTORY_REMEDIATION_RUNBOOK.md); the decision gate is [`DECISION_MATRIX_R1_R3.md`](DECISION_MATRIX_R1_R3.md).

> **This document changes nothing.** No branch, tag, ref or object was created, rewritten, deleted or pushed to
> produce it. Every tool below is **described**, not executed. The incident is `OPEN` for R1 and R3.
>
> **No identifier value appears here**, in any encoding. Refer to it as "the value" or `****5351`.

**Label legend:** **VERIFIED** (observed here or documented in this repository) · **REPORTED** (asserted elsewhere) · **UNKNOWN** (depends on GitHub internals, other people, or another machine).

---

## 1. The problem in one line

The working tree is clean and guarded (**VERIFIED**), but the value is still retrievable from the **public
default branch's history** (**VERIFIED**). Only a history rewrite, a repository rotation, or an accepted
exposure changes that. **A private repo does not** (§4).

### 1.1 Hard constraints any option must respect

| # | Constraint | Why | Label |
|---|---|---|---|
| C1 | **The six stacked Draft PRs (#41–#46) must survive or their loss must be accepted in writing** | They are the Slice 4–7 work in review; #41 is this effort's home branch lineage | REPORTED (stack in `PROJECT_STATE.md`) |
| C2 | **Preserve `stash@{0}` and `stash@{1}`** | Standing rule in `AGENTS.md`; `stash@{0}` is the pre-integration `main` WIP | VERIFIED (both present) |
| C3 | **Preserve `G:\ProjectAI\_backups\main-uncommitted-20261009`** | Standing rule; it is outside the repository, so a repo-local rewrite leaves it alone | VERIFIED (present) |
| C4 | **No force-push, no history rewrite, no merge without explicit owner approval** | `AGENTS.md` | VERIFIED |
| C5 | **The workspace must stay on one branch in one folder** — no worktrees | `AGENTS.md` | VERIFIED |
| C6 | **Rewriting the default branch is the only thing that removes it from `main`** | A feature-branch-only rewrite leaves `main` public | VERIFIED (`main` carries it) |

> **Good news about the constraints (VERIFIED reasoning):** a rewrite performed on a **separate mirror clone**
> (option b/d) never touches this workspace at all, so C2 and C3 are preserved by construction. The danger is a
> rewrite performed *in place* in this workspace.

---

## 2. Options matrix

Legend for the rows below: **removes** = what ceases to be reachable · **leaves behind** = what stays
reachable anyway · **PRs** = effect on #41–#46 · **force-push** = does it require one · **re-clone** = must
every collaborator discard their clone · **rollback** = can it be undone · **failure modes** = how it goes
wrong.

### 2.1 Side-by-side summary

| | (a) Do nothing + document | (b) `git filter-repo` (fresh clone) | (c) `git filter-branch` | (d) BFG | (e) Rotate repository | (f) Make repo private |
|---|---|---|---|---|---|---|
| **Removes the value from public history?** | **No** | **Yes, if all refs are rewritten and pushed** | Yes, slowly, with care | Yes, if all refs are handled | Yes — old repo archived/deleted | **No** |
| **Residue it does NOT remove** | everything | existing **clones / forks / scrapes**, **`refs/pull/*`**, **GitHub retention & caches**, plus reflog + unreferenced objects in *old* clones (until `gc`/expire) | same as (b) **plus** `refs/original/*` **and** the old objects it backs up | same as (b) | everything already cloned/forked from the **old** repo; its `refs/pull/*` | everything — no un-exposure at all |
| **Force-push required?** | No | **Yes** | **Yes** | **Yes** | No (new repo) | No |
| **Collaborators must re-clone?** | No | **Yes** (recommended) | **Yes** | **Yes** | **Yes** (change remote) | No |
| **Touches this workspace / stashes / backups?** | No | **No** (fresh clone) | **Risk — in-place by default** | **No** (fresh clone) | No | No |
| **Disruption to PRs #41–#46** | None | **Total loss / re-open required** | **Total loss / re-open required** | **Total loss / re-open required** | **Total for old repo PRs** | None |
| **Rollback** | N/A | Only from the mirror backup | Only from backup | Only from backup | Easy (keep old repo) | Trivial (make public again — but re-exposes) |
| **Effort / risk** | none / **exposure continues** | medium / **high blast radius** | high / fragile | medium / high blast radius | medium / high (loses PR history) | low / **misleading** |

### 2.2 Detail per option

---

#### (a) Do nothing, document the exposure

| Aspect | Assessment |
|---|---|
| **Removes** | Nothing. The value stays public and reachable. |
| **Leaves behind** | Everything: the value stays in `origin/main` history (tip `3244553`, since 2026-10-02) and in the history of **35 of 60** local refs; existing **clones / forks / scrapes**, **`refs/pull/*`**, **GitHub retention & caches** and every local **reflog / unreferenced object** are all untouched. Nothing about the exposure changes. |
| **PRs #41–#46** | No effect. |
| **Force-push** | No. |
| **Re-clone** | No. |
| **Rollback** | N/A. |
| **Failure modes** | Continued, unbounded public exposure; if the owner later changes their mind the window has grown and the clone population is larger. The decision must be recorded with a reason and a review date, not left implicit. |
| **When defensible** | Only if the privacy officer concludes the residual risk is low **and** the decision is written down with the reasoning and an owner. Note the internal policy rule was breached in a **public** repo, so "accept and record" is a decision for the owner, not an engineering default. |

---

#### (b) `git filter-repo` on a fresh clone, then force-push

The modern, supported history-rewrite tool. The recommended procedure is to `git clone --mirror` the repository
elsewhere, run the rewrite there, and force-push the result.

| Aspect | Assessment |
|---|---|
| **Removes** | The blob from the rewritten refs — **provided every ref is rewritten** (`--all`, plus explicit handling of tags and non-branch refs). The value is replaced/removed in all rewritten history. |
| **Leaves behind** | • **`refs/pull/*` on GitHub — UNKNOWN** whether a rewrite of branch refs removes the value's reachability through pull-request refs; this must be **verified after** the rewrite, not assumed. • **Existing clones/forks/scrapes — UNKNOWN, assume reachable.** • **GitHub-side caches/retention — UNKNOWN, depends on GitHub internals** (documentation/support would resolve it). • **Local reflogs and unreachable objects** in *your own* existing clone, until they expire — the rewrite must be done in a fresh mirror, not here. |
| **PRs #41–#46** | **Total loss of the stacked reviews unless they are re-created.** Rewriting shared bases rewrites every commit in the stack, so each PR's commits change identity (SHA), inline review comments attach to gone commits, and GitHub may auto-close PRs whose base was rewritten. The stacked chain `#41 → #40 → #39 → #37 → #36 → …` means rewriting `main` (or the lowest shared branch) rewrites **all** of them. Accepted-in-writing or re-created-then-retargeted is required. |
| **Force-push** | **Yes**, to every rewritten ref, including the protected default branch. Branch protection may block it; a temporary, logged exception (or an admin) is required. |
| **Re-clone** | **Yes, effectively.** Anyone with an old clone can push the old history back and re-introduce the value. Every collaborator must fetch-and-reset or re-clone, and be told not to push old history. |
| **Rollback** | Only from the verified mirror backup (see the runbook's pre-flight). Feasible **before** the old refs are pruned/expired; degraded afterwards. |
| **Failure modes** | • A ref left un-rewritten (a tag, a `refs/pull/*`, another branch) keeps the value alive — **the classic incomplete rewrite**. • A collaborator pushes an old clone. • A `refs/pull/*` ref survives and remains the exposure path. • The rewrite is run **in place** in this workspace and disturbs stashes/backups (avoidable — run it in a mirror). • A partial push (some refs updated, some not) leaves an inconsistent, half-rewritten repo. |
| **Verdict** | The technically strongest *in-place* option, **if** the owner accepts the PR-stack loss and the re-clone requirement, and **if** verification after the push proves the value is gone from every ref. |

---

#### (c) `git filter-branch`

The older, built-in rewrite tool.

| Aspect | Assessment |
|---|---|
| **Removes** | Same intent as (b): rewrites selected refs and drops the blob. |
| **Leaves behind** | Same as (b), **and** the tool writes its own backup refs (`refs/original/*`) which **still contain the old objects** unless explicitly removed — an easy way to leave the value reachable locally. |
| **PRs #41–#46** | Same total loss as (b). |
| **Force-push** | **Yes.** |
| **Re-clone** | **Yes** (same reasoning as b). |
| **Rollback** | From `refs/original/*` **or** the mirror backup. |
| **Failure modes** | All of (b), plus: git's own documentation discourages it for large rewrites; it is slow; it can behave differently across git versions; the `refs/original/*` backup is a second copy of the value unless carefully deleted. **Not the tool to choose today.** |
| **Verdict** | **Not recommended** — strictly dominated by (b)/(d). Listed because it is a common reflex. |

---

#### (d) BFG Repo-Cleaner

A purpose-built "remove this string/blob from history" tool (JVM), typically run on a fresh `--mirror` clone.

| Aspect | Assessment |
|---|---|
| **Removes** | A named blob or a set of lines matching a supplied file/pattern across all refs it is pointed at. |
| **Leaves behind** | Same as (b). BFG also rewrites all commit SHAs (it is not selective), so the PR-stack consequence is the same. |
| **PRs #41–#46** | Same total loss as (b). |
| **Force-push** | **Yes.** |
| **Re-clone** | **Yes.** |
| **Rollback** | From the mirror backup (which must be taken first). |
| **Failure modes** | Requires you to hand BFG the value (or a file containing it) as its input — **a process that must be handled so the value does not get written into a shell history, a log or another repo**. Requires line-exact or blob-exact targeting; a slightly wrong target silently misses. Same ref-coverage and re-clone hazards as (b). |
| **Verdict** | Equivalent outcome to (b) with a tool that is easier to mis-target on a *value* you are forbidden to reproduce carelessly. `filter-repo` (b) is preferable when the removal can be expressed by path/content rules rather than by pasting the value. |

---

#### (e) Rotate the repository — fresh repo, archive the old one

Create a new repository, push the **cleaned** current tree (and, if desired, a cleaned history) to it, and
archive or delete the old public repository.

| Aspect | Assessment |
|---|---|
| **Removes** | Nothing from the **old** repository while it exists. If the old repository is **deleted**, its history goes with it — but everything already cloned/forked/scraped persists. |
| **Leaves behind** | • Everything already cloned/forked/scraped by others from the **old** repo — **UNKNOWN, assume reachable**. • The old repository's **`refs/pull/*`** and history for as long as it exists (archive keeps it readable; only a hard **delete** removes it from GitHub). • GitHub-side **caches/retention** of the old repo — **UNKNOWN**. • Any external references (badges, links, docs) pointing at the old URL. |
| **PRs #41–#46** | The open PRs live in the **old** repository. They do **not** move. They must be re-created against the new repository (with new PR numbers) or lost. The stack's review comments do not transfer. |
| **Force-push** | No. |
| **Re-clone** | **Yes** — everyone must switch to the new remote. |
| **Rollback** | Easy — the old repository is retained. |
| **Failure modes** | • Treating "new repo" as done while the **old public repo still serves the value**; the old repo must be deleted (not just archived) to remove it from GitHub, and even then clones persist. • Losing repo settings, secrets/config that lived in the old repo, CI configuration, and the PR-review history (irreversibly). • Broken external links. |
| **Verdict** | A **containment + fresh-start** strategy, not a surgical fix. Reasonable if the team wants a clean slate and accepts the PR-history loss; **it is not equivalent to removing the value from a repository that others can already have.** |

---

#### (f) Make the repository private

| Aspect | Assessment |
|---|---|
| **Removes** | **Nothing.** It stops *future* public readers. The existing public history is exactly the thing that was exposed, and it is not retracted by a visibility change. |
| **Leaves behind** | Everything already cloned, forked, scraped, indexed or cached by third parties — **UNKNOWN, assume reachable**. Also, GitHub's own forks of a public repo become independent objects, and the value's blob in **`refs/pull/*`** and in any local clone's **reflog / unreferenced objects** is entirely unaffected. |
| **PRs #41–#46** | A visibility change is **disruptive to the whole Draft stack** for other reasons (e.g. this project's own tooling/clones, and reviewer access), but it does **not** remove the value. |
| **Force-push** | No. |
| **Re-clone** | No. |
| **Rollback** | Trivial to revert — but reverting **re-exposes** the value, so it is not a real rollback of anything. |
| **Failure modes** | Using it as the *whole* answer and believing the incident is mitigated. It also does not address GitHub's own participation (forks, PR refs) nor any clone already made. |
| **Verdict** | **Containment only.** Useful to stop the bleed while the real decision is made, **never** to be recorded as remediation. |

---

### 2.3 Residue taxonomy — the six places the value can survive

Every option in §2.2 is judged against the same residue list. "Removes" is only ever true **per location**:

| Residue location | What it is | Which options can clear it |
|---|---|---|
| **`origin/main` history** | the blob reachable through the default branch (tip `3244553`) | only (b)/(c)/(d) with `main` in the rewritten ref set, or (e) by **deleting** the old repo |
| **Other branch refs** | 35 of 60 local refs carry `3244553` in their history | (b)/(c)/(d); (e) by deleting the old repo |
| **`refs/pull/*` on GitHub** | pull-request refs may keep the blob reachable even after branch refs are rewritten — **UNKNOWN, must be verified** | verify *after* (b)/(c)/(d); (e) removes them with the old repo |
| **Existing clones / forks / scrapes** | held by third parties since 2026-10-02 — **UNKNOWN, assume reachable** | **none** of (a)–(f) can retract these |
| **GitHub retention / caches / API blobs** | GitHub-internal retention of the old object — **UNKNOWN** | **none** directly; documentation/support + post-rewrite verification |
| **Local reflog / unreferenced objects** | an in-place rewrite leaves the old blob reachable until `gc`/expire | avoided by running the rewrite in a **fresh mirror** (b)/(d); a hazard for in-place (c) |

**Reading the matrix with this table:** option (b) clears rows 1–2 (and, if verified, row 3) but leaves rows
4–6 untouched by construction. **No option clears row 4 at all** — which is why the incident cannot be "closed"
by a rewrite alone.

---

## 3. Constraints, examined explicitly

| Constraint | How each option interacts with it |
|---|---|
| **Stacked Draft PRs #41–#46** (REPORTED) | (a), (f): unaffected but leave the leak. (e): the old-repo PRs die with the repo. **(b), (c), (d): every PR in the stack is rewritten; expect auto-closure and loss of inline review threads.** Budget for re-creating and re-targeting the stack, or obtain a written "we accept losing them" from the owner. |
| **`stash@{0}`, `stash@{1}`** (VERIFIED present) | (a), (e), (f): untouched. **(b), (d): untouched *if the rewrite is done in a fresh mirror clone* → the correct procedure.** (c): **dangerous** — `filter-branch` runs in the current repository by default and can disturb local refs including stashes. |
| **`G:\ProjectAI\_backups\main-uncommitted-20261009`** (VERIFIED present) | Outside the repository: **no git operation touches it.** It must remain the pre-rewrite safety copy of the *uncommitted WIP*, not of the repository history. |
| **Protected default branch** | (b)/(c)/(d) require a **force-push to `main`**, which branch protection may block; a logged, temporary exception is needed. |
| **Published GitHub Pages / external links** | (e) breaks URL continuity; (b)/(d) preserve it. |
| **One workspace, no worktrees** (`AGENTS.md`) | Satisfied by doing the rewrite in a **separate mirror clone on disk** (a backup location, not a second workspace of this project), never by adding a worktree. |

---

## 4. What does NOT work

| Idea | Why it fails |
|---|---|
| **Delete the file (or the lines) in a new commit and push** | The commit removes the value from the **tip** only. The prior commit — and therefore the blob — stays reachable from history for anyone who clones or views the old commit. **The value stays public.** |
| **Make the repository private** | Does not retract anything already public. Existing clones, forks, scrapes and caches keep the value. (§2.2 f) |
| **Delete the branch that carried it** | The commits remain reachable through any ref that still contains them, and through GitHub's own object retention / PR refs. UNKNOWN whether an orphaned commit is immediately unreachable on GitHub — do not assume it is. |
| **`git gc` / `git prune` / `git repack` locally** | They do not remove the value from the **remote** at all, and running them here would **destroy recovery paths** in this workspace. Explicitly forbidden by this track's instructions. |
| **Rotate the secret/keys in the repo** | Irrelevant — the leaked thing is a national ID, not a credential. |
| **Add the value to `.gitignore`** | It is already committed; `.gitignore` affects only untracked files. |
| **Rely on the R4 CI guard** | The guard **prevents recurrence** in new commits; it cannot reach back into existing history. |
| **"Just force-push the redaction commit"** | The redaction (`04ff9d0`) is a **new commit on top** — pushing it to `main` by fast-forward leaves the parent commit and its blob in history. A force-push of a *rewritten* history is required, not a fast-forward of a new commit. |
| **Rewrite only the feature branches** | Leaves the value on the **default branch** — the exact place it is public and the single file that matters most. (§1 C6) |

---

## 5. Verification is part of the option, not after it

Any rewrite is **unverified until it is proven**, independently of the tool used (see the runbook's post-verification):

1. Every ref in the **pushed** remote is checked — branch refs, tags, and **`refs/pull/*`** — for the value, using a
   **canonicalizing** matcher (plain / dashed / Thai / full-width), reporting **counts only**, never printing a match.
2. The **masked** form `****5351` must not appear in any rewritten blob at any ref.
3. The workspace's redaction state, **both stashes** and the **_backups** directory are confirmed intact.
4. CI is green.
5. The stacked PRs are either re-created, or their loss is **accepted in writing**.

---

## 6. Recommendation (advisory — the owner decides)

* **Recommended primary:** **(b) `git filter-repo` on a fresh mirror clone**, executed only under the
  preconditioned runbook, **because** it is the only option that both removes the value from the public history
  *and* preserves this workspace's stashes and backups by construction (the rewrite happens in a separate
  clone). Its cost is the PR stack — which must be re-created or explicitly written off.
* **Not recommended:** **(c)** `filter-branch` (dominated, fragile, in-place) and **(d)** BFG (same blast radius,
  more ways to mis-target a value you are not allowed to reproduce carelessly).
* **Containment, not remediation:** **(f)** going private may be a reasonable *stop-the-bleed* step while the
  decision is made — never record it as remediation.
* **Acceptable alternatives given the constraints:** **(a)** if and only if the privacy officer concludes the
  residual risk is acceptable **and** the decision is documented with a review date; or **(e)** if the team
  wants a clean-slate repository and accepts losing the PR history.
* **In all cases:** the pre-flight mirror backup must exist and be **restore-verified** before any rewrite, and
  every collaborator must be told before the frozen window.

**This document describes options only. Nothing has been run. The incident remains `OPEN` for R1 and R3.**
