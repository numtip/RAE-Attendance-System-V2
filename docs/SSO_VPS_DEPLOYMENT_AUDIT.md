# SSO VPS deployment safety audit (Phase C)

> **Point-in-time record (2026-10-09), with a 2026-10-14 addendum.** For current
> state read `docs/J2_SSO_EOD_HANDOFF_20261012.md`, which supersedes this file
> where they differ. The evidence below is not rewritten and its **NO-GO**
> verdicts stay in force. The PR head, branch and migration ledger named here
> have since moved on (branch `phase-d/sso-security-remediation`, HEAD `13962ac`,
> migration `019` added but not applied). **Section 2.3 was added 2026-10-14 and
> supersedes this file's earlier "V2 is not deployed to production yet" claim.**

Date: 2026-10-09. Repo `numtip/RAE-Attendance-System-V2`, branch `integration/attendance-sso-hip`, Draft PR #34 head `7d810d8`. No SSH, no deploy, no migration, no secret or personnel data was read. Phase B (MJU IT written confirmation) stays skipped by owner decision. This audit does not certify the protocol.

## Verdict

| Step | Verdict | Why |
|---|---|---|
| Merge #30, #33, or #34 | **NO-GO** | Legacy host automation is not observed. A merge to `main` does publish GitHub Pages. Migration 017 privileges and the #33 `.gitignore` conflict are still open. |
| Staging SSO pilot | **NO-GO** | No separate staging host. V2 containers were seen on the same host as legacy `attendance-api`. SSO flags stay off. The pilot plan below needs a later, separate approval. |
| Production SSO | **NO-GO** | Not claimed. Login CSRF and the in-memory replay store are open. |

## 1. What the repo actually deploys

Evidence is the files below. There is no systemd unit, PM2 file, or host cron in the repo.

| Source | What it does | Reaches the legacy VPS by itself? |
|---|---|---|
| `.github/workflows/pages.yml` | On **push to `main` only**: build the frontend with `VITE_REVIEW_MODE=fixture` and `actions/deploy-pages@v4` | No. It updates public GitHub Pages. Last Pages run seen 2026-10-09 is still `main` `3244553` (2026-10-02). |
| `.github/workflows/ci.yml` | On pull request, and on push to `main`: tests, throw-away MariaDB, `docker compose ... up` then `down -v`. Image build sets `push: false` | No. Runner-local. |
| GitHub settings checked 2026-10-09 | 0 repo webhooks, 0 Actions secrets, 0 Actions variables. Only environment: `github-pages` | No hook from GitHub to a VPS was found. |
| `deploy/README.md` | "Nothing in this directory is applied to the legacy host without an approved cutover (GitHub-first / VPS-last)." V2 is not deployed to production yet. | Documented policy, not a live observation. |
| `deploy/docker-compose.yml` | Header: disposable local/staging stack, not production. `migrate` service runs `npm run db:migrate:seed` when that compose project starts. Backend env sets `SSO_ENABLED=false`. One backend container. | Only if an operator runs this compose on a host. Not wired to `main`. |
| `deploy/docker/backend/Dockerfile` | `CMD node src/server.js`. Default `DATA_SOURCE=fixture`. No migrate step. | No. |
| `deploy/docker/frontend/nginx.conf` | Listens 8080 inside the image. Proxies `/api/v1/` to `backend:3210`. | No. |
| `deploy/nginx/rae-attendance-v2.conf.template` | Commented: not applied automatically. TLS lines are comments. | No. |
| `docs/DEPLOYMENT_RUNBOOK.md` | Lab commands only. Production cutover is out of scope and points at other docs plus operator approval. | No. |
| `scripts/migrate.mjs` | Manual. Default `MYSQL_HOST=127.0.0.1`, port `3307`. Nothing in the repo calls it against a production host. | No, unless some host cron (not in the repo) invokes it. |

**Merge to `main` therefore has two different effects:**

1. **Proven:** GitHub Actions will run CI, and `pages.yml` will republish the public fixture SPA. PR #34 adds `/auth/sso/complete`, which auto-exchanges the handoff code (`frontend/src/views/SsoCompleteView.vue`). That page has no backend session until SSO is enabled on an API. The Pages site is not the legacy VPS.
2. **Not proven:** whether the legacy host pulls `main`, restarts, or migrates. `deploy/README.md` says it does not, until an approved cutover. That sentence is not a substitute for the read-only host check. If the host does pull `main`, merging #30 still adds migration files that an auto-migrate would apply.

Do not merge while (2) is unknown.

## 2. VPS read-only commands (do not run from an agent)

Ask the VPS administrator to run these. Read-only. Do not edit, restart, pull, migrate, or deploy. Redact secrets, tokens, and personal data before sending the output back. Replace `<deploy dir>` and `<deploy user>`.

```sh
hostname; whoami; date -u; uname -a; head -3 /etc/os-release
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' || true
systemctl list-units --type=service --state=running | grep -i -E 'rae|node|pm2|nginx' || true
pm2 list || true
pgrep -af 'node|pm2' || true

cd <deploy dir>
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short | head
git remote -v
git log -1 --format='%H %cd %s'

crontab -l || true
sudo crontab -l -u <deploy user> || true
ls /etc/cron.d /etc/cron.daily /etc/cron.hourly 2>/dev/null
systemctl list-timers --all | head -30
ps aux | grep -i -E 'webhook|adnanh|hooks|deploy|watchtower|runner' | grep -v grep || true

grep -R -n -i -E 'db:migrate|migrate\.mjs|schema_migrations|npm run db' \
  <deploy dir>/package.json <deploy dir>/deploy /etc/systemd/system 2>/dev/null | head
# names of the running unit only; do not print Environment= values
systemctl cat <rae-unit> 2>/dev/null | grep -E '^(ExecStart|WorkingDirectory|User)=' || true

ss -tlnp | head -30
```

Database, read-only account, names only. Do not `SELECT` employee or identifier tables.

```sql
SELECT VERSION();
SHOW VARIABLES LIKE 'log_bin%';
SHOW VARIABLES LIKE 'log_bin_trust_function_creators';
SELECT version FROM schema_migrations ORDER BY version;
```

Reply as a table: auto-pull (yes/no), auto-migrate (yes/no), active branch, HEAD SHA, backend process count, runtime (container/PM2/systemd), last migration filename, `log_bin` on/off. If auto-pull or auto-migrate is yes, or the active branch is `main`, or more than one backend process is running, stop. Do not change the host.

### 2.1 Phase C2 record (updated 2026-10-09 08:48 UTC, authorized read-only)

Session identity: `hostname` `raeserver`, user `rae_admin`, `eth0` `10.1.245.190/24`. Runtime compose directory: `/home/rae_admin/rae-attendance-v2-runtime`. This pass did not SSH, restart, pull, checkout, merge, deploy, migrate, rebuild, or change SSO flags. No `.env` was read. The checkout branch is **not** the production branch. Image tag `abb2792` was not used as a commit.

| Field | Value | Result |
|---|---|---|
| auto-pull | User crontab has three jobs, all backup or collect scripts, and no `git pull` or `docker pull`. `/etc/crontab` and `/etc/cron.d` have no attendance, pull, or migrate match. Timer `check-raeservice-attendance.timer` runs `/usr/local/bin/check-raeservice-attendance.sh`, which only curls health URLs and exits 1 (`ActiveState=failed`). No watchtower or webhook process. Compose `pull_policy` is `never` for MariaDB and frontend. Root crontab and the bodies of `backup_db.sh` and `kri_collect.sh` were not readable. | **ACCESS BLOCKED** |
| auto-migrate | Compose project `rae-attendance-v2` has services `mariadb`, `backend`, and `frontend` only. Backend command is `node src/server.js`. The image `src` tree has no `migrate` or `schema_migrations` reference. Readable cron has no migrate command. Root crontab and the two unreadable script bodies remain unread. | **ACCESS BLOCKED** |
| active branch | `/home/rae_admin/rae-attendance-v2-runtime/.git` is absent. The directory is not its own checkout. `git -C` that path walks up to `/home/rae_admin`, a different repository, and that result is rejected as provenance. | **PASS** |
| HEAD SHA | Image `Config.Labels` is empty. `/app` has no revision file. No build metadata carries a git SHA. | **UNKNOWN** |
| backend process count | One V2 container `rae-v2-backend` `e6bd2f5e3c87`, one `node src/server.js` (host pid 2022290, cgroup of that container). Host pid 2056002 is `node src/server.js` inside legacy container `4a6001ddbd8f`, not a second V2 backend. PM2 god daemon has zero app pid files. | **PASS** |
| runtime | Docker Compose project `rae-attendance-v2`. Backend image has no OCI labels. Frontend `nginx:alpine` on `127.0.0.1:8088`. MariaDB `mariadb:11.4` has no published host port. | **PASS** |
| last migration filename | `attendance_v2.schema_migrations`, ordered: `001` through `010`, then `013_personnel_identifier.sql`. Versions `011`, `012`, and `014` through `018` are absent. | **PASS** |
| `log_bin` | `log_bin` OFF. `log_bin_trust_function_creators` OFF. Basename and index are empty. | **PASS** |

**Image `abb2792` provenance: UNKNOWN.** `deploy/docker/backend/Dockerfile` copies source and sets `CMD ["node", "src/server.js"]`. It has no `ARG`, `LABEL`, or `ENV` for a git SHA. The earlier image inspect recorded only id and creation time. The tag string matches a local commit prefix and is not evidence that the image was built from that commit.

Checkout evidence, kept separate from the serving release: git root is this repo, remote `https://github.com/numtip/RAE-Attendance-System-V2.git`, branch `docs/mju-subject-evidence-pack`, HEAD `9ceb6ac5fb273051fce73dc597c33e3b915e82a4`. Local `main` was `e3cef26`. Neither SHA is the runtime commit.

Also seen, and not a second V2 backend: legacy container `attendance-api` (`docker-raeserver-attendance-api:latest`, `127.0.0.1:3000`). V2 publish was `127.0.0.1:3210` (API) and `127.0.0.1:8088` (frontend nginx). `rae-v2-mariadb` (MariaDB 11.4) had no published port. Timer `check-raeservice-attendance.timer` exists. Its service `ExecStart` is the health-check script and `ActiveState` is `failed`. `Environment=` was not printed.

**Closed by this pass:** active branch is not a git branch, V2 backend count is one, live migration ledger ends at `013_personnel_identifier.sql`, and `log_bin` is off. **Not closed:** runtime commit stays **UNKNOWN**. **ACCESS BLOCKED:** root crontab (`sudo -n` asked for a password; `/var/spool/cron/crontabs/root` is not readable) and the bodies of `/home/rae_admin/docker-raeserver/backup_db.sh` and `/home/rae_admin/risk/kri_collect.sh`.

| Remaining | Why it still blocks |
|---|---|
| auto-pull | Readable jobs show no attendance pull. Root crontab is ACCESS BLOCKED, so host-wide "no" is not proven. A later yes is still an immediate NO-GO. |
| auto-migrate | The running V2 compose and image startup do not migrate. Root crontab and the two script bodies are ACCESS BLOCKED. A later yes is still an immediate NO-GO. |
| active runtime commit | Empty OCI labels and no revision file. Tag `abb2792` is not a SHA. |

**Administrator checklist.** Read-only. Stop on yes for auto-pull or auto-migrate, on served branch `main`, or on more than one V2 backend. Do not restart, pull, migrate, or print secrets.

Credential caution: `crontab -l`, `sudo crontab -l`, `ps aux`, `systemctl cat`, and compose/`docker inspect` can show tokens in command arguments, `Environment=`, and environment files. Record only the keys below. Do not cat `.env`. Do not print `Environment=` lines. Redact anything that looks like a password, token, connection string, or personnel id before sending output back.

```sh
# Names and times only
hostname; whoami; date -u

# V2 instance count: names, images, status. Do not print env.
docker ps --filter name=rae-v2 --format '{{.Names}}\t{{.Image}}\t{{.Status}}'

# Provenance only if a label exists. Do not print Config.Env.
docker image inspect rae-attendance-v2-backend:abb2792 \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'

# Runtime dir is not assumed to be a git checkout
git -C /home/rae_admin/rae-attendance-v2-runtime rev-parse --show-toplevel || true
git -C /home/rae_admin/rae-attendance-v2-runtime rev-parse --abbrev-ref HEAD || true
git -C /home/rae_admin/rae-attendance-v2-runtime rev-parse HEAD || true

# Cron and timers: command names only. Redact URLs that contain credentials.
crontab -l || true
sudo crontab -l -u rae_admin || true
ls /etc/cron.d /etc/cron.daily /etc/cron.hourly
systemctl list-timers --all --no-pager | head -30
ps aux | grep -i -E 'webhook|adnanh|hooks|deploy|watchtower|runner' | grep -v grep || true

# Unit identity only. Never print Environment= or EnvironmentFile contents.
systemctl cat check-raeservice-attendance.service 2>/dev/null \
  | grep -E '^(ExecStart|WorkingDirectory|User)=' || true
```

Database, read-only, names and flags only. Do not `SELECT` employee or identifier tables.

```sql
SELECT VERSION();
SHOW VARIABLES LIKE 'log_bin%';
SHOW VARIABLES LIKE 'log_bin_trust_function_creators';
SELECT version FROM schema_migrations ORDER BY version;
```

Phase C2 verdict stays **MERGE NO-GO**, **STAGING PILOT NO-GO**, **PRODUCTION SSO NO-GO**.

### 2.2 VPS source sync (2026-10-09)

Owner approved a source sync only. No production deploy.

| Item | Observed |
|---|---|
| Host | `raeserver` (`10.1.245.190`) |
| Existing checkout | `/home/rae_admin/RAE-Attendance-System-V2`, branch `docs/mju-subject-evidence-pack`, HEAD `9ceb6ac5fb273051fce73dc597c33e3b915e82a4`. Tracked tree unchanged. Untracked local file `docs/SSO_VPS_DEPLOYMENT_AUDIT.md` left in place. Ignored `.local/`, `backend/node_modules/`, `frontend/node_modules/`, `frontend/dist/` left in place. |
| Fetch | `git fetch origin integration/attendance-sso-hip`. Remote `origin/integration/attendance-sso-hip` is `7d810d8ac6b851b3bc3d9a4ef9b1b74bd9189929`. Matches expected `7d810d8`. |
| New worktree | `/home/rae_admin/worktrees/RAE-Attendance-System-V2-integration`. Branch `integration/attendance-sso-hip` tracks `origin/integration/attendance-sso-hip`. HEAD `7d810d8ac6b851b3bc3d9a4ef9b1b74bd9189929`. `git diff` against that remote is empty. Status clean. |
| Hooks | `.git/hooks` contains sample files only. No deploy hook ran. |
| Secret scan | `node scripts/secret-scan.mjs` in the new worktree: passed, 292 tracked files. No tracked `sampleCallback*`, `.env`, `.pem`, or `.key`. |
| Runtime | Unchanged. Container ids before and after: `rae-v2-backend` `e6bd2f5e3c87`, `rae-v2-frontend` `10cd5a0e265e`, `rae-v2-mariadb` `d22f3548f390`, `attendance-api` `4a6001ddbd8f`. Image `rae-attendance-v2-backend:abb2792` id `sha256:f3c73604b779f93c6eaa7087bd474d25a45f8ab9f8536708ffe54a65663a9382`. Runtime directory `/home/rae_admin/rae-attendance-v2-runtime` was not modified. |

**VPS Source Sync Completed.** The new worktree matches GitHub `integration/attendance-sso-hip` at `7d810d8`. Production runtime is still the previous image. This sync is not a deploy. PR #34 stays a Draft. **MERGE NO-GO. STAGING PILOT NO-GO. PRODUCTION SSO NO-GO.**

Section 2.1 was updated after this sync by an authorized read-only pass. The worktree branch is not the production branch. Runtime commit, auto-pull, and auto-migrate were not closed by the sync.

### 2.3 Runtime routing and exposure (2026-10-14, read-only)

Measured on `raeserver` without root. No file was changed. `sudo -v` in an interactive terminal does not carry to a non-tty agent shell, so the root crontab and `/etc/sudoers.d/` were still not readable; everything below is non-root evidence.

**The V2 app is already served on the production domain.** `/etc/nginx/sites-enabled/raeservice.mju.ac.th.conf` (mtime 2026-10-01 06:37) contains:

* `location = /attendance-v2` -> `301` to `/attendance-v2/`
* `location ^~ /attendance-v2/` -> `proxy_pass http://127.0.0.1:8088/` (V2 frontend)
* `location ^~ /api/v1/` -> `proxy_pass http://127.0.0.1:3210/api/v1/` (V2 backend)
* a comment: `# Release 1 SHA 9bc709d5a85078fe732e0b8b35fed4b4d380fa4e`

Local probes returned `200` for `http://127.0.0.1:8088/`, `http://127.0.0.1:3210/api/v1/health` and the legacy `http://127.0.0.1:3000/`. Only `0.0.0.0:80` and `0.0.0.0:443` are bound publicly; `8088` and `3210` listen on loopback only.

| Item | Finding |
|---|---|
| Release 1 SHA recorded in nginx | `9bc709d5` = merge commit of PR #16 (`feat/release1-final-signoff`, 2026-10-01). It **is** an ancestor of `origin/main`, so nothing outside main's history is being served. |
| Served frontend assets | `/home/rae_admin/rae-attendance-v2-runtime/frontend-dist`, mtime 2026-10-01, consistent with the nginx comment. |
| Runtime env | Keys `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED` and `DATA_SOURCE` exist in `/home/rae_admin/rae-attendance-v2-runtime/.env`. The **values were not read**, so this pass does not report their state. |
| PM2 | `pm2-rae_admin.service` is active, but `$HOME/.pm2/dump.pm2` is absent, so PM2 currently manages zero applications. |
| Health timer | `check-raeservice-attendance.timer` runs every 15 minutes and only curls health URLs; it deploys nothing. |
| `/opt/rae-attendance` | Not a git checkout. Holds legacy helper scripts dated Nov 2025, not a deploy path. |

**This corrects the earlier claim that "V2 is not deployed to production yet".** V2 is reachable on `raeservice.mju.ac.th` at `/attendance-v2/` and `/api/v1/`. Whether it answers from the public internet depends on the host firewall and any Cloudflare layer, which this pass did not test; the nginx listeners on `80`/`443` are bound to `0.0.0.0`.

Seen but not readable without root: `/etc/sudoers.d/attendance-frontend-deploy` (mtime 2025-09-25) exists but does **not** appear in `sudo -l` for `rae_admin`, so it grants some other account a frontend deploy command. `rae_admin` itself has `(ALL : ALL) ALL` with a password, plus `NOPASSWD` only for `/usr/local/bin/cleanup-joomla-190.sh`.

## 3. Replay store (single process)

`backend/src/services/sso/mjuPortalGuard.js`: each `ac` is a SHA-256 digest in a process-local `Map`. TTL 1 hour. Cap 10,000; the oldest digest is deleted. Bindings expire after 10 minutes and are single-use. The guard is not shared and does not survive a restart.

| Event | Effect | Status |
|---|---|---|
| Restart | Digests are gone. The same `ac` can be presented again. MJU single-use is unknown, so this is not mitigated. | Open |
| Cap eviction | After 10,001 later codes, the oldest digest can be claimed again. Test: `guard: the oldest code digest is dropped after the in-memory cap`. | Open |
| Two or more processes | Each process has its own map. A code refused on one process can be accepted on another. | Open. Do not run more than one backend until a shared durable store exists. |

Compose starts one backend container. That does not make the store durable.

## 4. Login CSRF on `?ac=`

MJU's sample sends the browser to `signin.aspx?cid=` and later to the callback with `ac`. It does not echo `state` and this audit does not assume PKCE or a pass-through field.

**What our code already does**

- Server-generated HttpOnly `SameSite=Lax` cookie, `Path=/api/v1/auth/sso`, `Secure` in production (`ssoController.js`).
- Callback without that cookie is `403` before `token.aspx`.
- The binding is burned on use.
- `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on the callback.
- Handoff code is single-use, 45 seconds. `SsoCompleteView.vue` exchanges it automatically on load.

**What that does not prove**

A browser that has just started login will accept any unused `ac` with that cookie. An attacker who has their own `ac` can send the victim's browser to our callback during the 10-minute window. The victim's session becomes the attacker's session. This is login CSRF, not theft of an existing session. Closing it needs a value that MJU returns unchanged and that we can match to the login we started. We do not have that value.

**Changes that stay on our side (not implemented here)**

| Change | Closes the hole? |
|---|---|
| Shorter binding TTL | No. Shrinks the window. |
| Confirm button before `POST /auth/sso/exchange`, instead of exchange-on-load | No. A click is not proof the `ac` belongs to that login. It does stop a silent navigation. |
| Shared replay store | No. Different issue. |
| Asking MJU to echo a nonce | Would close it only if they actually echo it. Not assumed. |

Until one of those protocol facts exists, call the control "browser binding", not "CSRF closed".

## 5. Staging pilot plan (not authorized to run now)

Host: a disposable compose stack or another non-legacy host. Not the production VPS. One consenting account. One backend process. Flags set outside git, on that host only: `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED`, `SSO_MJU_TOKEN_FLOW=true`, sign-in URL, token URL, `SSO_SUBJECT_CLAIM=humanID`. Leave both `*_CONTRACT_CONFIRMED` flags false. No client secret. `npm run sso:preflight` must exit 0 and list residual risks.

| Case | Pass |
|---|---|
| Positive | Login, callback, HMAC map, `/me`, logout, refresh token revoked. New link is `candidate:humanID`, source `mju_token_candidate_subject`, confidence `medium`. |
| Negative | Missing cookie, replayed `ac`, missing or multi-value `humanID`, subject equal to citizen ID or email or name, unknown citizen ID, subject already linked to someone else. No session and no new link. |
| Rollback | Set `SSO_ENABLED=false` or `SSO_MJU_TOKEN_FLOW=false` and restart that staging process only. No migration is required for the pilot. |
| Fail the pilot | Any negative case opens a session, more than one backend process, preflight exit non-zero, or the link is stored as a citizen ID, email, or name. |

Do not widen to the 50-person scope from a single pass.

## 6. Residual risks and next actions

Still open, and not mitigated by this document:

1. Section 2.1 now records the authorized read-only pass. Live migrations end at `013_personnel_identifier.sql`, `log_bin` is off, and one V2 backend is running. Runtime commit is still UNKNOWN. Root crontab and two backup-script bodies are ACCESS BLOCKED, so auto-pull and auto-migrate are not closed. Section 2.2 records a source-only worktree at `7d810d8`; the runtime image was not changed. These facts do not authorize a merge.
2. **Section 2.3 supersedes the "V2 is not deployed to production yet" wording.** V2 frontend and API are proxied on the production domain `raeservice.mju.ac.th` (`/attendance-v2/`, `/api/v1/`) and answer `200` locally. The served build traces to `9bc709d5`, already in `main`. This is exposure, not auto-deploy: nothing observed deploys on its own, and the question of public reachability was not tested.
3. Login CSRF as in section 4.
4. Replay store is process-local (section 3).
5. `ac` lifetime and single-use at MJU, response signing, and whether `humanID` is stable are still unknown. Phase B was skipped; that did not answer them.
6. Migration 017 on a real database needs `SUPER` or `log_bin_trust_function_creators=1`. **Read on 2026-10-14: `log_bin=0` on this host, so the 1419 requirement does not apply and the `SUPER` item is moot while binary logging stays off** (`docs/MIGRATION_017_PRIVILEGES.md`). Not tested on production data and not approved.
7. After #30 merges, #33 conflicts on `.gitignore`. Resolution remains: keep every #30 rule and append `mju-person-enrich.zip`. A `git merge-tree` dry-run on 2026-10-14 confirmed the conflict is `.gitignore` only.
8. PR #34 is still a Draft based on `docs/mju-subject-evidence-pack`, not `main`. The working branch `phase-d/sso-security-remediation` is **[PR #35](https://github.com/numtip/RAE-Attendance-System-V2/pull/35)**, Draft, base `integration/attendance-sso-hip`; CI at `90f7b53` and `13962ac` is 8/8 green.

Next, in order, each with its own approval: receive the section 2 table; only then consider merge order #30, #33 (gitignore), #34/#35. A staging pilot is a separate approval after the host for that pilot is named. Do not SSH, merge, or enable flags as part of reading this file.
