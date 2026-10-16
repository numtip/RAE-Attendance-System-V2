# Next-session handoff — start here

**Written:** 2026-10-16 16:20 (Asia/Bangkok), at the close of `DAY_20261016_CLOSED`.
**Read with:** [`../STATUS.md`](../STATUS.md) (current state) and [`SESSION_20261016.md`](SESSION_20261016.md)
(what happened). `../SESSION_HANDOFF.md` is the **pre-Slice** record and carries another session's WIP — it is
not the starting point any more.

---

## 1. Start exactly here

```powershell
cd G:\ProjectAI\rae-attendance-system-v2
git.exe status -sb          # expect: 4 modified (pre-existing WIP), branch docs/id6b-review-and-r1r3-package
git.exe stash list          # expect: 2 stashes — never delete them
git.exe rev-parse HEAD      # expect: 3f2f343
```

**Starting branch:** `docs/id6b-review-and-r1r3-package` @ `3f2f343` — the tip of the whole stack.
**Do not** start from `main` (local `main` is stale at `e3cef26`) or from `docs/SESSION_HANDOFF.md`.

**Then, before planning anything:** consult Jev once, per the always-applied rule
`.cursor/rules/agent-core-jev.mdc`:

```powershell
. .\agent\scripts\use-live-credentials.ps1   # DPAPI store -> this shell only; prints no secret
node agent\scripts\live-smoke.mjs            # ONE call. Advisory only.
```

If it is unreachable, **say so and continue** on deterministic work. Never block, never invent a consult.

## 2. First actions, in priority order

| # | Action | Why |
|---|---|---|
| **1** | **Triage the open privacy incident (R1/R3).** Decide (a) whether and whom to notify, (b) which history-remediation option. | It is the **only** item with an **active external exposure**: a real national ID is still retrievable from **public** `origin/main` history. Package is ready in `docs/incident/`. Neither decision has been made. |
| **2** | **Approve or reject migration `025`** (+ `ADR-011`). | The durable fix for the enrichment-outcome guard. The security fix already shipped **without** it, so this is a *relaxation*, not a hole being closed. |
| **3** | **ID-3 / G7 — activate real identity integration?** | Blocked on a **DPIA + privacy-officer sign-off**. Also blocked technically by **ID-5**: the MJU Person API returns **no `personnelID`**, so it cannot populate the MJU identity kind. |
| **4** | **R-05b** — add a cross-employee code lookup so a change of code holder is *positively* detected. | Today the payload honestly says `crossEmployeeOwnershipDetection: {evaluated: false}`. |
| **5** | **D-02** — locate the legacy `attendance_db`. | **Not** on the local USBServer MySQL 5.6; that server also **cannot host V2** (6 migrations use `JSON`). |
| **6** | Optional: **ID-4** (the missing `MJU_PERSON_ENRICHMENT_KB.md`), **R2** (name the accountable approver), **R8/S2-D** (holiday calendar), **P-03** (night-shift lateness). | Each removes a caveat that currently appears on real reports. |

## 3. Approval gates — do NOT proceed past these without the owner

| Gate | Decision needed | Blocks |
|---|---|---|
| **R1** | Whether and whom to notify (draft ready, **not sent**) | PDPA obligations |
| **R3** | Which history-remediation option; approval for a rewrite **and** a force push | Removing the value from public history |
| **G-mig** | `ADR-011` + migration proposal `025` | Durable identity evidence |
| **ID-7b-rem** | The `enrichment_outcome` column (or accept the fail-closed posture permanently) | Relaxing the guard |
| **ID-3 / G7** | Activate real identity integration (needs DPIA + privacy-officer sign-off) | The MJU identity kind |
| **R-05b** | A cross-employee code-lookup method | Positive ownership detection |
| **Merge** | Merging **any** of #40–#48, and the lower stack #30/#33/#34/#35 first | Everything above is a Draft |

## 4. Hard rules that must not be relaxed

* **Never push, merge, retarget, force-push or rewrite history without explicit owner approval.** PR #44
  targets `main` deliberately; the rest are stacked. **All stay Draft.**
* **The leaked value `****5351` must never be reproduced in any encoding** — not plain, not dashed, not
  Thai digits, not full-width — in code, docs, logs, commits, PR text, session memory or Agent Core.
  Note: a *redaction* regex matching only `\b\d{13}\b` let three of four encodings through once already.
* **Never label a control production-safe without real-twin evidence.** Fixture green is necessary, not
  sufficient. Standing rules 6, 13 and 14 exist because of exactly this.
* **Preserve** `stash@{0}`, `stash@{1}`, `G:\ProjectAI\_backups\`, the 4 pre-existing modified files, the 19
  pre-existing untracked entries, and the single worktree. `AGENTS.md` forbids new worktrees.
* **Never `git add -A`**; call `git.exe`; use `git commit -F` with a temp message file.
* **No PII to Agent Core**, ever. Sanitisation is enforced inside `agent/decisions.js`.

## 5. If you need to run the MariaDB suites locally

A throwaway MariaDB works and was used today. **One file per process** — the aggregate run is not a valid
signal on Windows (rule 14):

```powershell
$env:RUN_MARIADB_TESTS='1'; $env:CI='true'; $env:TZ='UTC'
$env:DB_HOST='127.0.0.1'; $env:DB_PORT='3399'; $env:DB_NAME='attendance_v2'
$env:DB_USER='root'; $env:DB_PASSWORD=''
node --test --test-force-exit tests/identityLinkEnrichment.mariadb.test.js   # one file
```

Requirements learned today: **`TZ=UTC`**, a **fresh** database per run for the idempotency suite, and the
portable download lives **outside the repo** (it was deleted at closeout — re-download
`mariadb-11.4.2-winx64.zip` from `archive.mariadb.org` if needed; ~87 MB, and `mysqld` matches CI's version).

## 6. Where everything lives now

| Question | File |
|---|---|
| What is the current state? | [`../STATUS.md`](../STATUS.md) |
| What happened today? | [`SESSION_20261016.md`](SESSION_20261016.md), and `../SESSION_SUMMARY_20261016_PARALLEL_TRACKS.md` |
| What should I do next? | [`NEXT_ACTIONS.md`](NEXT_ACTIONS.md) |
| Why is it built this way? | [`DECISIONS.md`](DECISIONS.md) |
| How do reports work? | `../unified/10_*` (R-02), `11_*` (R-03), `14_*` (R-05) |
| How does reconciliation work? | `../unified/12_*` |
| What is the identity contract? | `../IDENTITY_MAPPING_CONTRACT.md`, `../IDENTITY_INTEGRATION_AUDIT.md` |
| What is the privacy incident? | `../SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`, `../incident/` |

## 7. One-paragraph orientation

Today delivered the report and export layers (R-02, R-03, R-04, R-05) and the identity hardening, and
**found two things that mattered more than the features**: a security control that passed every local test
while doing nothing in production, and a real national ID sitting in the public repository's history. The
first is fixed and proven on a real database. The second is **contained but not resolved** — that is the
first thing to deal with next.
