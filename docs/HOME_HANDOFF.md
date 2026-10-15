# HOME_HANDOFF — continue at home in minutes

**As of:** 2026-10-15 (Asia/Bangkok). Repo: `https://github.com/numtip/RAE-Attendance-System-V2` (public).
Goal: reproduce Slice 1 + Slice 2, run the full local QA, and continue from the next milestone.

**Labels:** **VERIFIED** = observed at the cited command on 2026-10-15 · **REPORTED** · **UNKNOWN**.

---

## 1. What you get from GitHub

| Branch | Tip SHA | Contains |
|---|---|---|
| `docs/daily-closeout-20261015` | `9e17f05` | **Slice 1 + Slice 2 + these memory docs (everything)** — PR #38 |
| `feat/slice2-attendance-engine` | `d279bba` | Slice 1 + Slice 2 (the code; **no** memory docs) — PR #37 |
| `feat/slice1-employee-master-foundation` | `5910819` | Slice 1 only (base of PR #37) — PR #36 |
| `integration/attendance-sso-hip` | `7d810d8` | the pre-existing stack baseline |

All four are **in sync with origin** (VERIFIED with `git rev-parse` + `git ls-remote`).
`origin/main` is `3244553` and does **not** yet contain Slice 1/2 — expected, since PRs #36/#37/#38 are
Draft and unmerged.

**Which branch to use at home:** check out **`docs/daily-closeout-20261015`**. It is the Slice 2 code plus
this documentation set, so the `docs/memory/*` files referenced below are actually present. Checking out
`feat/slice2-attendance-engine` gives the identical code but **without** the memory docs (they live only on
the docs branch, deliberately, so PR #37 stays code-only).

## 2. Setup — PowerShell, copy-paste

```powershell
# 1. Clone (this repo is public; no credentials needed for read)
cd G:\ProjectAI
git clone https://github.com/numtip/RAE-Attendance-System-V2.git rae-attendance-system-v2
cd rae-attendance-system-v2

# 2. See every branch, then check out the slice tip (code + these docs)
git fetch --all --prune
git checkout docs/daily-closeout-20261015
git log --oneline -8          # expect 9e17f05 at the top, then d279bba, ... 7d810d8 as the base

# 3. Install dependencies. Root, backend and frontend each have a package-lock.json -> use npm ci.
npm ci
Push-Location backend ; npm ci ; Pop-Location
Push-Location frontend; npm ci ; Pop-Location
# agent/ has NO dependencies and NO lockfile - nothing to install (this is the S2-H gap)

# 4. Full local QA (no database, no VPS, no network required)
$env:JWT_SECRET = 'test-only-secret'                 # test-only value, never a real secret
Push-Location backend
npm run lint                                         # expect: clean
npm test                                             # expect: 342 tests, 333 pass, 0 fail, 9 skipped
Pop-Location
node scripts/contract-smoke.mjs                      # expect: ok (22 API_CONTRACT paths, DATA_SOURCE=fixture)
Push-Location frontend ; npm run build ; Pop-Location # expect: vue-tsc + vite build ok
Push-Location agent ; node --test tests/*.test.js ; Pop-Location   # expect: 46/46
node scripts/secret-scan.mjs                         # expect: secret scan passed

# 5. Optional: lint agent/ too (its own config exists; eslint is borrowed from backend)
Push-Location agent ; ..\backend\node_modules\.bin\eslint.cmd . ; Pop-Location   # expect: clean
```

**No database is required.** The suite runs in `DATA_SOURCE=fixture` and the MariaDB tests skip themselves.
To run them you need a throw-away local MariaDB (never production):

```powershell
$env:RUN_MARIADB_TESTS='1'
$env:DB_HOST='127.0.0.1'; $env:DB_PORT='3307'; $env:DB_NAME='attendance_v2'
$env:DB_USER='attendance'; $env:DB_PASSWORD='<local throw-away only>'
npm run db:migrate:seed        # applies migrations 001-023 to the LOCAL database only
Push-Location backend ; $env:JWT_SECRET='test-only-secret' ; npm test ; Pop-Location
```

**Do not point `db:migrate` at any real host.** The live ledger is pre-`013` and no apply order is proposed
(`docs/memory/PROJECT_STATE.md` §5).

## 3. Agent Core at home — environment variable **names** only

Set these **in `.env` (never committed)** or in your shell. **No values are recorded in this repository.**

| Variable | Purpose |
|---|---|
| `AGENT_CORE_URL` *or* `AGENT_PLATFORM_URL` | Gateway base URL. `AGENT_CORE_*` wins if both are set |
| `AGENT_CORE_PROJECT` *or* `AGENT_PROJECT` | Project id; defaults to `rae-attendance-v2` |
| `AGENT_CORE_PROJECT_TOKEN` *or* `AGENT_PROJECT_TOKEN` | Project token (if auth is enabled) |

Check the boundary without any credentials or network:

```powershell
node agent/cli.js doctor                       # config summary + the unsupported-endpoint list; prints NO token
node agent/cli.js probe --path /v1/route       # expect supported:false, AGENT_CORE_UNSUPPORTED_ENDPOINT
node agent/cli.js decide --use-case architecture_review --summary "local check"
```

Without credentials `decide` returns a deterministic `FALLBACK` that **requires human approval** and exits 0.
That is the designed offline behaviour, not a failure.

**Remember (VERIFIED from `agent-core` source):** the project holds scope **`decision` only**. Only
`POST /v1/decision` is callable; `TASK_ROUTE` is unavailable; `QA_DISPOSITION` works **only** as a
`decision_type` on `/v1/decision`. **Agent Core is never on the attendance request path**, so it being down
cannot block or alter a calculation.

## 4. Local-only prerequisites (NOT on GitHub — by design)

These exist only in the office workspace. **All are intentionally excluded from the repository** (PII,
secrets, or another session's uncommitted work). None is required to build or test Slice 1/2.

| Item (path / category) | Why it is local-only | Needed at home? |
|---|---|---|
| `database/IDCardRaecsv2027.csv` | real personnel data; gitignored, never commit | **No** — tests use synthetic data |
| `database/local/` | import batches and reconciliation output | **No** |
| `mju-person-enrich.zip` | gitignored archive | **No** |
| `.env` | secrets; **does not currently exist** in the workspace | Optional (Agent Core only) |
| `docs/sampleCallback.aspx`, `.vb` | vendor evidence; must not be committed | **No** |
| `G:\ProjectAI\_backups\main-uncommitted-20261009` | local safety net (patch + SHA256SUMS) | **No** |
| `stash@{0}`, `stash@{1}` | **git stashes do not transfer through clone or push** | **No** to build; see below |
| Pre-existing uncommitted WIP (18 entries) | another session's work; deliberately not published | **No** to build; see below |
| `node_modules/` (root, backend, frontend) | reinstalled with `npm ci` | **No** |

### 4a. What the clone will NOT have (and it is not needed to reproduce Slice 2)

The 18 pre-existing WIP entries are **not** on GitHub, including `docs/RAE_ATTENDANCE_UNIFIED_PLATFORM_BLUEPRINT_V1.md`
and `docs/unified/00`–`05`. That means some cross-references in `docs/unified/06`/`07`/`08` will dangle at
home (they cite `docs/unified/03`, `05`, etc.).

**This is a documentation gap, not a code gap** — no source file needed to build or test Slice 1/2 is
local-only. Remedies if you want the full doc set at home: copy those files from the office workspace
manually (they are safe Markdown, no PII), or ask the owner whether to publish them in a separate docs PR.
The stashes likewise cannot be transferred; if they matter, take a patch from the office machine
(`git stash show -p`), not a copy of `.git/`.

## 5. Verification checklist after cloning

| Check | Expected | If it fails |
|---|---|---|
| `git rev-parse HEAD` | `9e17f05…` on `docs/daily-closeout-20261015`, or `d279bba…` on `feat/slice2-attendance-engine` | you are on the wrong branch |
| `Test-Path docs/memory/PROJECT_STATE.md` | `True` (docs branch only) | check out `docs/daily-closeout-20261015` |
| `cd backend; npm test` | 342 tests, 333 pass, **0 fail**, 9 skipped | confirm `node --version` is ≥ 20 |
| `node scripts/contract-smoke.mjs` | `ok (22 API_CONTRACT paths)` | run it from the repo root |
| `cd agent; node --test tests/*.test.js` | 46/46 | — |
| `cd frontend; npm run build` | vite build ok | `npm ci` in `frontend/` first |
| `node scripts/secret-scan.mjs` | `secret scan passed` | it scans **tracked** files only |

## 6. Copy-ready RESUME prompt

> Continue the RAE Attendance System V2 work. Workspace `G:\ProjectAI\rae-attendance-system-v2`, branch
> `docs/daily-closeout-20261015` (tip `9e17f05`) — or `feat/slice2-attendance-engine` (tip `d279bba`) for
> the code without the memory docs.
>
> First read, in this order: `docs/memory/PROJECT_STATE.md`, `docs/memory/NEXT_ACTIONS.md`,
> `docs/memory/DECISIONS.md`, then `docs/unified/07_SLICE2_ATTENDANCE_ENGINE.md` and
> `docs/ATTENDANCE_RULES.md`.
>
> State: Slice 1 (PR #36) and Slice 2 (PR #37) are complete, independently verified, 8/8 CI green, and both
> remain **Draft and unmerged**. Do not merge, retarget, force-push, or apply any migration to a real
> database. Preserve all pre-existing WIP and both stashes.
>
> Next milestone: **employee attendance reports**. It is blocked on owner approval of an attendance rule
> version (`AR-0001` is `pending_approval`, so the engine currently reports `pending_policy` and produces no
> numbers). Ask me to approve a rule before building any report surface, and tell me if you believe the
> milestone should instead start with `monthly_summary` (task R-01).
>
> Standing hazards: never format a stored date with `String(value).slice(0, 10)` — MariaDB returns a `Date`
> and the fixture twins return strings; use `wallDateOnly()`. The fixture/MariaDB twins hide type divergence,
> so local green is not sufficient. Never rename an applied migration.
>
> Use `git.exe` (not the `git` shell function). Never `git add -A`.

## 7. Home readiness

**`HOME_SYNC_READY`** — all source required to reproduce, build and test Slice 1 and Slice 2 is on GitHub
at `feat/slice2-attendance-engine` @ `d279bba`, verified in sync with `origin`. The gaps listed in §4a are
documentation and local safety nets only, and none of them blocks a build, a test run, or the next
milestone. No VPS, production database, or credential is needed.
