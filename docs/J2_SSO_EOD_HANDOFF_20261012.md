# J2-SSO end-of-day handoff — 12 Oct 2026

Host: `10.1.245.190` (`raeserver`). Repo: `/home/rae_admin/RAE-Attendance-System-V2`.
Branch: `phase-d/sso-security-remediation`. Prior baseline: `a6a18d5`.
No production migration, restart, deploy, SSO enable, Cloudflare change, or credential creation.

**Update (2026-10-14, read-only verification).** This branch is [PR #35](https://github.com/numtip/RAE-Attendance-System-V2/pull/35) (Draft, OPEN, base `integration/attendance-sso-hip`, head `phase-d/sso-security-remediation`, 27 files +1432/-53) — an earlier revision of this handoff did not record that the PR exists. CI on `2bc999c` was **6/8, red**: `backend` and `backend-mariadb` both failed at the lint step (see the QA correction below). Local commits after `2bc999c`: `f4b672a` (Phase C evidence docs + ignore `.local/`) and `82e2847` (the lint fix). Both are **unpushed**.

Prior evidence, not rewritten: `docs/SESSION_HANDOFF.md` (2026-10-09), `docs/SSO_PROTOCOL_EVIDENCE.md`, `docs/SSO_IDENTITY_FLOW.md` (Pass 9 handoff, Pass 10 deferral), `docs/SSO_PHASE_D_SECURITY_REMEDIATION.md`, `docs/MIGRATION_017_PRIVILEGES.md`. Local notes that stay untracked: `.local/J2_SSO_BLOCKER_REMEDIATION.md`, `.local/J2_SSO_017_DBA_CHECKLIST.md`.

## Status

| Item | Result |
|------|--------|
| Shared claim store and opt-in adapter | **DONE** |
| Migration 013 additive SQL | **DONE** (reviewed; historical 013 files not edited) |
| Migration 019 schema file | **DONE** (not applied) |
| In-memory SSO default | **REUSED** |
| `ac` replay table `sso_consumed_code` | **REUSED** (not used for binding or handoff) |
| Migration 017 | **BLOCKED** |
| Jev authenticated decision | **BLOCKED** |
| MJU subject / `ac` certification | **BLOCKED** |
| Staging | **NO-GO** |
| Production | **NO-GO** |
| PR #35 (this branch) | Draft, OPEN, base `integration/attendance-sso-hip` |
| PR #35 CI at `2bc999c` | **6/8 - lint failure** (fixed in `82e2847`, unpushed) |

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

1. Push `f4b672a` and `82e2847` to `origin/phase-d/sso-security-remediation` (fast-forward, no force), then confirm PR #35 CI is 8/8. **Needs explicit approval.** Do not push as part of any other task.
2. Operator: Cloudflare Access grant, then project-token handoff. Dependency: Jev smoke. Do not call port 8787 or bypass Access.
3. DBA: sign the 017 checklist, then a staging-only apply. Dependency: zero collisions from `database/preflight/017_preflight.sql`. Do not grant `SUPER` while `log_bin=0`.
4. Staging database: apply `019` only there, set `SSO_SHARED_CLAIM_STORE=true` on that process, rerun the disposable two-process test against that database. Do not point it at `rae-v2-mariadb`.
5. Production-shaped identifier change: use the additive 013 script only under a separate approval. Do not run historical `013_employee_identifier_foundation.sql` there.
6. MJU IT: `ac` lifetime and which field is the stable subject. Dependency for any live login.

## Do not repeat

* Do not `git add -A`, force-push, or merge.
* Do not run stock `migrate.mjs` on production.
* Do not edit historical migration filenames or bodies.
* Do not store binding or handoff rows in `sso_consumed_code`.
* Do not enable SSO, restart production, or change Cloudflare from this repo.
* Do not treat `docs/SESSION_HANDOFF.md` sections 1–10 as the current SHA. They are the 2026-10-09 record.
