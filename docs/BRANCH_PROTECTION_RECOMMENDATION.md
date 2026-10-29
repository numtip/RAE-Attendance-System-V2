# Branch protection for `main` — recommendation (no setting changed)

**Status:** prepared 2026-10-29. **Nothing was changed.** Repository settings and permissions are the
owner's to change; this document only states what to enable and why, with the exact commands.

**Verified current state** (`gh api repos/numtip/RAE-Attendance-System-V2/branches/main/protection`,
2026-10-29): `Branch not protected` (HTTP 404). Anyone with write access can push straight to `main`,
force-push it, or delete it. By contrast, `numtip/mju-sso-integration` is protected (0 required
reviews, conversation resolution required, force-push and deletion blocked, admins not enforced).

That asymmetry matters now: every control this project relies on — CI green before merge, a PR
history, "the SHA in the document is the SHA that was reviewed" — is currently a convention for the
pilot, not an enforced rule. Today a stale branch or a direct push can put an unverified change on
`main` and no gate objects.

---

## 1. Recommended rules, in priority order

| # | Rule | Setting | Why |
|---|---|---|---|
| 1 | **Require a pull request before merging** | `required_pull_request_reviews.required_approving_review_count = 0` | Blocks direct pushes without blocking a solo maintainer. A review-count of 1 would make the owner unable to merge without a second GitHub account; conversation resolution (3) still forces every comment to be answered. |
| 2 | **Require status checks to pass** | checks: `backend`, `backend-mariadb`, `compose-smoke`, `container`, `frontend`, `pages-build`, `secrets`, `agent-core` | These are the 8 jobs that already run. Enforcing them converts "CI was green when I looked" into "CI is green on this commit". |
| 3 | **Require branches to be up to date before merging** (strict) | `strict = true` | This is the rule that would have caught the stale-CI problem in this repository: five PRs carried week-old green runs against bases 4–5 commits behind `main`. Slightly slower merges; removes a whole class of false confidence. |
| 4 | **Require conversation resolution** | `required_conversation_resolution = true` | An unresolved review thread cannot be merged past. |
| 5 | **Block force pushes** | `allow_force_pushes = false` | `main` history must be append-only; a force-push breaks every recorded SHA. (Feature branches stay force-pushable — that is how a rebase works.) |
| 6 | **Block deletions** | `allow_deletions = false` | One mis-click cannot remove the branch. |
| 7 | **Require linear history** (optional) | `required_linear_history = true` | The repo merges with squash. Enforcing it keeps that true and makes `git bisect` usable. Skip it if a merge-commit style is ever wanted. |
| 8 | **Do not enforce on admins** (deliberate) | `enforce_admins = false` | Keeps a break-glass path for the owner during an incident. The cost is that the owner *can* bypass, so the bypass must be recorded — see §4. |

**Not recommended now:** required signed commits (adds key management for one maintainer),
required deployments (nothing is deployed from Actions), code-owner reviews (needs a second human).

---

## 2. Exact commands (run by the owner, not an agent)

```bash
# 1–6 in one call
gh api -X PUT repos/numtip/RAE-Attendance-System-V2/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["backend", "backend-mariadb", "compose-smoke", "container",
                 "frontend", "pages-build", "secrets", "agent-core"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

# verify
gh api repos/numtip/RAE-Attendance-System-V2/branches/main/protection
```

## 3. How to verify the rules actually bite (do this once, immediately after enabling)

1. Open a throwaway PR that changes one comment. Confirm it **cannot** be merged while a check is
   pending.
2. On that PR, push a second commit; confirm the required "up to date" rule asks for a rebase against
   `main` when `main` has moved.
3. Leave a review comment, then try to merge: it must refuse until the thread is resolved.
4. Try `git push --force origin main` from a scratch clone: it must be rejected.
5. Close the throwaway PR without merging and delete its branch.

If any step does not behave as described, the rule is not configured as intended — fix it before
relying on it in any document.

## 4. Break-glass procedure (for the `enforce_admins = false` choice)

If a rule blocks a genuine incident fix:

1. Write down, in the PR or the incident note: what is blocking, why the fix cannot wait, and what the
   fix is.
2. Merge with the admin bypass; the merge is recorded in the audit log with the bypass flag.
3. Within one working day, re-run the checks on `main` and record the result next to the note from
   step 1.

A bypass that is not recorded is indistinguishable from a mistake, which is why step 1 is not optional.

## 5. Risks this does **not** address

- **Required checks are only as good as the jobs.** `backend-mariadb` and `compose-smoke` are the jobs
  that caught the last two real defects (a broken migration ordering and a secret-scan regression);
  keep them.
- **A green check is not a review.** Nothing here inspects the diff. The SSO work in this repo depends
  on written policies (`docs/SSO_ACTIVATION_CHECKLIST.md`) and on the shared standard's negative
  tests, not on GitHub's settings.
- **Secrets are outside this scope.** Protection does not stop a credential being committed; the
  `secrets` job and `scripts/secret-scan.mjs` do, which is why its own test file is now in CI.
