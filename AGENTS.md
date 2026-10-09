# AGENTS.md

**Before doing any work in this repo, read `docs/SESSION_HANDOFF.md`.** It holds the current branch, PR status, QA state, known issues, gates and next steps. If it conflicts with your memory of an earlier chat, the handoff wins; verify with `git` before acting.

## Workspace and repo

* One local workspace: `G:\ProjectAI\rae-attendance-system-v2`. Several Git **branches** are fine; do **not** create Git worktrees or extra project folders.
* One GitHub repo: `numtip/RAE-Attendance-System-V2`. One production deployment.
* Current working branch: `integration/attendance-sso-hip` (PR #34, Draft, stacked on PR #30). Check `git status -sb` first.
* Windows PowerShell: call `git.exe` (the `git` shell function can be broken); write commit messages to a temp file and use `git commit -F`. Never use `git add -A` (the CSV and `database/local/` are protected only by `.gitignore`).

## Product scope

* Simple MJU SSO (Login -> MJU -> callback -> identity mapping -> Attendance session -> logout) plus HIP attendance. HIP people do not need SSO and never get a fake SSO account.
* A verified SSO subject maps to `employee_uid`; never match by name or email alone. The MJU protocol and the callback `ac` value are **unconfirmed**; do not assume OIDC.
* `database/IDCardRaecsv2027.csv` is the confirmed scope: **50 unique people** (52 rows, 2 exact duplicates). Never edit, commit, copy or print values from the original file; tests use synthetic data only.

## Working rules

* Use TOKEN_SAVIOR: targeted reads and searches, existing scripts and tests, no whole-repo dumps.
* Never put PII, secrets, National IDs (mask as `****NNNN`) or CSV content into code, docs, logs, commits or PR text.
* Do **not** push, merge a PR, SSH, run production migrations/imports/deploys, change or create secrets, or force-push without explicit approval from the user. Keep PR #34 a Draft until told otherwise.
* Preserve `stash@{0}`, `stash@{1}` and `G:\ProjectAI\_backups\`; never delete them without approval.
* Do not rename migration files (the ledger keys on the filename). Details are in the handoff.
