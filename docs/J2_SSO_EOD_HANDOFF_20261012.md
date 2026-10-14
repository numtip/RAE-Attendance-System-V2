# J2-SSO end-of-day handoff — 12 Oct 2026

Host: `10.1.245.190` (`raeserver`). Repo: `/home/rae_admin/RAE-Attendance-System-V2`.
Branch: `phase-d/sso-security-remediation`. Prior baseline: `a6a18d5`.
No production migration, restart, deploy, SSO enable, Cloudflare change, or credential creation.

**Update (2026-10-14, verification + approved push).** This branch is [PR #35](https://github.com/numtip/RAE-Attendance-System-V2/pull/35) (Draft, OPEN, base `integration/attendance-sso-hip`, 30 files +1766/-54) — earlier revisions of this handoff did not record that the PR exists. CI on `2bc999c` was **6/8, red**: `backend` and `backend-mariadb` both failed at the lint step (see the QA correction below). It was fixed in `82e2847`. With approval, `f4b672a`, `82e2847` and `90f7b53` were pushed fast-forward (`2bc999c..90f7b53`), and **CI on `90f7b53` is 8/8 green** with `mergeStateStatus: CLEAN`. Read-only host checks the same day closed the auto-pull and auto-migrate question and cleared the 017 privilege item; see section 11.

**Owner decisions (2026-10-14):** **do not merge any PR yet** and **do not migrate any database**, production or otherwise. The read-only preflights were run and passed; that is not approval to apply.

Prior evidence, not rewritten: `docs/SESSION_HANDOFF.md` (2026-10-09), `docs/SSO_PROTOCOL_EVIDENCE.md`, `docs/SSO_IDENTITY_FLOW.md` (Pass 9 handoff, Pass 10 deferral), `docs/SSO_PHASE_D_SECURITY_REMEDIATION.md`, `docs/MIGRATION_017_PRIVILEGES.md`. Local notes that stay untracked: `.local/J2_SSO_BLOCKER_REMEDIATION.md`, `.local/J2_SSO_017_DBA_CHECKLIST.md`.

## Status

| Item | Result |
|------|--------|
| Shared claim store and opt-in adapter | **DONE** |
| Migration 013 additive SQL | **DONE** (reviewed; historical 013 files not edited) |
| Migration 019 schema file | **DONE** (not applied) |
| In-memory SSO default | **REUSED** |
| `ac` replay table `sso_consumed_code` | **REUSED** (not used for binding or handoff) |
| Migration 017 | **Privilege item CLEARED 2026-10-14** (`log_bin=0`); a real apply is still **NOT APPROVED** |
| Jev authenticated decision | **BLOCKED** |
| MJU subject / `ac` certification | **BLOCKED** |
| Staging | **NO-GO** |
| Production | **NO-GO** |
| PR #35 (this branch) | Draft, OPEN, base `integration/attendance-sso-hip` |
| PR #35 CI at `90f7b53` | **8/8 green**, `mergeStateStatus: CLEAN` (was 6/8 at `2bc999c`) |
| Merge of any PR (2026-10-14) | **NOT APPROVED** by owner decision |
| Migration of any DB (2026-10-14) | **NOT APPROVED** by owner decision |

## QA

Node 20.19.5, no production database:

* SSO, MVP, MJU token flow, Pass 9, callback wiring, identity chain, Release 1 auth, shared-claim opt-in: **84 pass, 0 fail**.
* **Correction (2026-10-14):** that run did not cover `npm run lint`, and lint was red on `2bc999c` (the commit that added the shared-claim store). `backend/eslint.config.js` declares globals as an explicit list with no `__dirname`, and `sourceType: 'commonjs'` does not supply it, so `backend/tests/ssoSharedClaimStore.mariadb.test.js` failed with 3 `no-undef` errors. This is why PR #35 CI was 6/8. Fixed in `82e2847` with the `/* global __dirname */` header this repo already uses in `backend/tests/idcardCsvIdentity.test.js`. Re-verified on Node 20.19.5: `npm run lint` exit 0, `JWT_SECRET=ci-fixture-only-secret npm test` 201 pass / 0 fail / 8 skipped. **Always run lint, not tests alone, before calling this branch green.**
* Note: `node` on the host PATH is v12.22.9; the project needs Node 20. Use `~/.nvm/versions/node/v20.19.5` for any local QA.
* Earlier the same day, disposable MariaDB 10.11 on `127.0.0.1:3319` (container removed): two OS processes, one binding consume and one handoff consume each had exactly one winner; expiry, replay, missing table, and `IDENTITY_NOT_APPROVED` then 401 also passed (**86 pass, 0 fail** including those cases).
* Secret content scan of the committed paths: no private keys, no filled `OPENROUTER_API_KEY`, no password assignment.

## Migrations

| File | Status |
|------|--------|
| `013_employee_identifier_foundation.sql` and `013_personnel_identifier.sql` | Historical. Not modified. Do not run the foundation file on the production-shaped database (duplicate unique key, and earlier DDL can commit first). |
| `database/reconcile/013_employee_identifier_additive.sql` | Additive and idempotent. Outside `scripts/migrate.mjs`. Fresh appends `personnel_id`. Production-shaped enum order stays. After a failed historical 013, it does not undo the enum reorder. |
| `017_identifier_namespace_claim.sql` | Not applied. Production `log_bin=0`. `TRIGGER` is only on `root`. Checklist: `.local/J2_SSO_017_DBA_CHECKLIST.md`. |
| `019_sso_shared_claim.sql` | Forward-only table `sso_shared_claim`. Not applied. Not a substitute for `018_sso_consumed_code`. |

## Shared store

* Default: `SSO_SHARED_CLAIM_STORE` is unset, so login binding and handoff stay in process memory.
* Opt-in: `SSO_SHARED_CLAIM_STORE=true` plus a configured MariaDB pool. Missing pool or a database error is **503** `SSO_SHARED_STORE_UNAVAILABLE`. No memory fallback.
* Rollback: leave the flag unset and do not run `019`. No service restart is required for this commit because production was not switched.

## Jev / OpenRouter

* `GET https://agent.raemanagemju.net/v1/health` over IPv4: **200**, version `0.7.0`, `auth_required: true`, `provider_configured: true`, model `~typesafe/jev-latest`.
* Agent Core sets `provider_configured` from `OPENROUTER_API_KEY` on the gateway (`agent-core` `src/config.ts`). That key is not on this host.
* `POST /v1/decision` from this host: **403** Cloudflare Access (WARP off, gateway off, mTLS none). The application token check was not reached.
* This host has no `AGENT_CORE_URL`, `AGENT_CORE_PROJECT`, `AGENT_CORE_PROJECT_TOKEN`, or `OPENROUTER_API_KEY`.
* Minimum fix: an operator Access grant for this client on `POST /v1/decision`, then an approved `rae-attendance-v2` project token through the existing secret channel. Do not create or copy a token in chat or git.

## MJU

Token, userinfo, and the stable subject are not certified. `humanID` remains a candidate. `ac` lifetime and single-use at MJU are unknown. Do not enable `SSO_ENABLED`.

## Next tasks

1. ~~Push and confirm CI.~~ **DONE 2026-10-14:** pushed `2bc999c..90f7b53` fast-forward; CI on `90f7b53` is 8/8 green. No further push is pending.
2. Merge: **NOT APPROVED.** The auto-pull/auto-migrate blocker is now answered "no" (section 11.1) and the merge dry-run is in 11.3, but the owner decided on 2026-10-14 not to merge yet. When it is approved, the order is `#30` -> resolve `#33`'s `.gitignore` -> `#33` -> `#34`/`#35`, each with its own approval.
3. Operator: Cloudflare Access grant, then project-token handoff. Dependency: Jev smoke. Do not call port 8787 or bypass Access.
4. DBA: the `SUPER` question is moot while `log_bin=0` (section 11.2). Any staging-only apply still needs its own approval; `database/preflight/017_preflight.sql` returns zero collisions today.
5. Staging database: apply `019` only there, set `SSO_SHARED_CLAIM_STORE=true` on that process, rerun the disposable two-process test against that database. Do not point it at `rae-v2-mariadb`.
6. Production-shaped identifier change: use the additive 013 script only under a separate approval. Do not run historical `013_employee_identifier_foundation.sql` there.
7. MJU IT: `ac` lifetime and which field is the stable subject. Dependency for any live login.

## Do not repeat

* Do not `git add -A`, force-push, or merge.
* Do not run stock `migrate.mjs` on production.
* Do not edit historical migration filenames or bodies.
* Do not store binding or handoff rows in `sso_consumed_code`.
* Do not enable SSO, restart production, or change Cloudflare from this repo.
* Do not treat `docs/SESSION_HANDOFF.md` sections 1–10 as the current SHA. They are the 2026-10-09 record.

## 11. Read-only host verification (2026-10-14)

Run on `raeserver` itself (this workspace is the VPS checkout, so no SSH was needed). No write, no restart, no pull, no migration, no flag change. These readings change no status above except where named.

### 11.1 Auto-pull and auto-migrate — both **NO**

This is the item the 2026-10-09 audit left **ACCESS BLOCKED**, and it is the decision-rule input that blocked the first merge.

| Check | Reading |
|---|---|
| `crontab -l` (non-comment lines) | Three jobs, all backup or collect: `backup_db.sh`, `risk/kri_collect.sh`, and an unrelated `/opt/raenew2026/scripts/backup.sh`. **No `git pull`, no `git fetch`, no migrate.** |
| `sudo crontab -l` (root, closed 2026-10-14) | Two active jobs: `certbot renew`, and a 5-minute `curl` health check of `https://raeservice.mju.ac.th/health`. **No pull, no fetch, no migrate, no deploy.** |
| `/etc/sudoers.d/attendance-frontend-deploy` | One **disabled** rule (`[removed 2026-09-25 by joomla-cleanup bootstrap]`) granting `NOPASSWD` for the legacy `/home/rae_admin/real-attendance-system/scripts/deploy-landing-fix.sh`. That script no longer exists and the directory is not a git checkout. |
| `/etc/cron.d`, `cron.daily`, `cron.hourly` | `certbot`, `e2scrub_all`, `php`, `ssh_monitor` and distro defaults. No pull, deploy or migrate match. |
| webhook / watchtower / CI-runner processes | None running. |
| Runtime compose (`/home/rae_admin/rae-attendance-v2-runtime/docker-compose.yml`) | Services `mariadb`, `backend`, `frontend` only. **No `migrate` service.** `pull_policy: never` on mariadb and frontend; backend pinned to the local tag `rae-attendance-v2-backend:abb2792`. |
| Backend container | `Cmd ["node","src/server.js"]`, entrypoint `docker-entrypoint.sh`. No migrate step. |
| Runtime directory | Still **not** a git checkout (no `.git`), so it cannot pull a branch. |

**Answer: nothing on this host pulls or deploys `main` automatically, and nothing migrates at container start-up.** The root crontab was read on 2026-10-14 (section 11.5) and holds only `certbot renew` and a health-check `curl`, so this is now a **root-level** answer, not just a non-root one. The two unread script bodies are a database backup and a collect script; neither can deploy V2. Residual uncertainty is limited to an unseen process outside cron, systemd and docker, which is not a realistic deploy path here.

**Decision rule, cleared.** Section 6 of the 2026-10-09 audit blocks the first merge when auto-pull is yes, auto-migrate is yes, or the served branch is `main`. All three are now **no**: auto-pull no, auto-migrate no, and the runtime directory is not a git checkout at all. **The host-side blocker on the first merge is cleared.** Merging still needs its own approval (see the owner decisions at the top of this file), and `#33` still needs its `.gitignore` resolution first.

### 11.2 Preflights on the live database — **pass**, nothing applied

Read-only `SELECT` on `attendance_v2` in `rae-v2-mariadb` (MariaDB 11.4.10). Counts only; no identifier values were selected.

* `database/preflight/015_preflight.sql`: `national_id_rows_pre_015=0`, `legacy_plaintext_national_rows=0`, `thirteen_digit_values_in_other_types=0`, `employees_with_multiple_national_rows=0`, `duplicate_type_value_groups=0`, `orphan_identifier_rows=0`, `missing_unique_key_from_013=0`.
* `database/preflight/017_preflight.sql`: `cross_employee_namespace_collisions=0`, `values_in_both_namespaces_same_or_other_employee=0`, `employee_identifier_table_present=1`, `id_value_collation=utf8mb4_unicode_ci`.
* `log_bin=0`, `log_bin_trust_function_creators=0`, `binlog_format=MIXED`. Triggers in `attendance_v2`: 0.
* Ledger `schema_migrations` ends at `013_personnel_identifier.sql`; `011`, `012`, `014`–`019` are all unapplied.

**Consequence:** because `log_bin` is OFF, the error-1419 row does not apply, so `CREATE TRIGGER` needs no `SUPER` and the "DBA decision: `SUPER` or set `log_bin_trust_function_creators=1`" item is **moot on this host**. The remaining requirement is only `TRIGGER`, held by the account used for the read (`root@localhost`, `ALL PRIVILEGES`). Details: `docs/MIGRATION_017_PRIVILEGES.md`. This is a privilege answer, **not** approval to apply.

### 11.3 Merge dry-run

* `#30` (`docs/mju-subject-evidence-pack`) into `main`: **clean**, no conflicted path.
* `#33` (`feat/facescan-ingestion-phase-a`) against a tree that already contains `#30`: conflicts on **`.gitignore` only** — exactly the single conflict the 2026-10-09 handoff predicted. The resolution stays: keep every `#30` rule and append `mju-person-enrich.zip`.

### 11.4 Still open after this pass

1. ~~Root crontab~~ **CLOSED 2026-10-14** — see 11.5. Auto-pull and auto-migrate are **NO** at root level. The two unread script bodies (`backup_db.sh`, `kri_collect.sh`) are a database backup and a collect script, not a deploy path.
2. The stock runner is still unsafe against this database: a `migrate.mjs` run would attempt `013_employee_identifier_foundation.sql`, which conflicts with the live unique key and enum order (see `docs/SSO_SCHEMA_RECONCILIATION.md`). Applying 017 is not a one-command operation.
3. `#33`'s `.gitignore` conflict is proven but **not yet resolved**; it must be resolved before `#33` merges second.
4. Everything in sections 3–6 that was BLOCKED before is still BLOCKED.

### 11.5 Root-level cron and sudoers (2026-10-14)

Run by the operator in an interactive terminal, because `sudo -v` does not carry to a non-tty agent shell (sudo timestamps are per-TTY; the agent shell gets "a password is required"). Read-only, nothing changed. Full detail: `docs/SSO_VPS_DEPLOYMENT_AUDIT.md` section 2.4.

* `sudo crontab -l` — active jobs are only `0 12 * * * certbot renew --quiet` and `*/5 * * * * curl -fsS https://raeservice.mju.ac.th/health || echo ... >> /var/log/health_fail.log`. **No pull, fetch, migrate or deploy.**
* `sudo grep -rn -i -E 'git pull|git fetch|db:migrate|migrate\.mjs|deploy' /var/spool/cron/crontabs /etc/cron.d /etc/cron.daily /etc/cron.hourly` — the only hit is a commented-out line inside the root crontab comment block mentioning `deploy-landing-fix.sh`. No active job matches.
* `/etc/sudoers.d/attendance-frontend-deploy` (151 bytes, root:root, `-r--r-----`, mtime 2025-09-25) — one **disabled** rule for `NOPASSWD /home/rae_admin/real-attendance-system/scripts/deploy-landing-fix.sh`. The script no longer exists and that directory is not a git checkout.

### 11.6 V2 is already served on the production domain

Also learned 2026-10-14 while closing 11.5: `/etc/nginx/sites-enabled/raeservice.mju.ac.th.conf` proxies `/attendance-v2/` to `127.0.0.1:8088` and `/api/v1/` to `127.0.0.1:3210/api/v1/`, naming Release 1 SHA `9bc709d5` (merge of PR #16, an ancestor of `origin/main`). Local probes answer 200. Only ports 80 and 443 are bound publicly. This corrects the earlier "V2 is not deployed to production yet" wording. It is exposure, not auto-deploy. Public reachability through the firewall or Cloudflare was not tested, and the runtime `.env` values for `SSO_ENABLED`, `SSO_CALLBACK_CONFIRMED` and `DATA_SOURCE` were not read. Details: `docs/SSO_VPS_DEPLOYMENT_AUDIT.md` section 2.3.
