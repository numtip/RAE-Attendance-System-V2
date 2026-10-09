# PR review: SSO integration (`integration/sso-hip-identity`) vs PR #30

Local review only. Nothing was pushed, merged, migrated, imported or deployed. All test data is synthetic.

## 1. Lineage and merge order

```
origin/main 3244553  (Identity foundation + FaceScan raw ingestion Phase A, #32)
  └─ PR #30  work/pr30-secure-onboarding  0448492 -> 0a5e492   (HMAC+key version, migration 015, policy docs, SSO prep)
       └─ PR-B  feat/secure-identifier-integration  83aaa53 -> 6e2bd60   (one shared National ID crypto contract; MJU/HIP identity kinds)
            └─ PR-C  integration/sso-hip-identity  5986749 -> (hardening commit)   (SSO chain, migration 017, protocol fail-closed)
```

| Step | Content | Size vs previous |
|---|---|---|
| PR #30 | 28 files vs `origin/main` (+2533/-11) | base |
| PR-B | 21 files (+2956/-317) vs PR #30 | depends on #30 |
| PR-C | this branch vs PR #30: 64 files (+6209/-406) in total, of which PR-B is a part | depends on PR-B |

**Required order:** PR #30 -> PR-B -> PR-C. Open PR-B/PR-C stacked on the previous branch (base = previous branch) and retarget to `main` after each merge. PR-C must not merge before PR-B because it imports `nationalIdContract.js` and `identityKind.js`; PR-B must not merge before #30 because it extends migration 015's HMAC model.

**Dependencies / conflicts to resolve before merging:**
* `feat/facescan-ingestion-phase-a` (main workspace, `00b92c5`) owns migration numbers `015_facescan_hip_ingestion.sql` and `016_attendance_events.sql`; PR #30 already uses 015 (`..._secure_lookup`). Decide numbering before either merges. 017 was chosen to avoid the 016/015 clash with facescan.
* The PR #30 lineage carries a second `013_*` file (`013_personnel_identifier.sql`, from `9ceb6ac`): hygiene item for #30.
* PR-C changes `ssoService.beginLogin/handleCallback` signatures (browser binding). The frontend is unaffected (`/auth/sso/login` is a redirect; the cookie is set by the backend). Nothing else calls these functions.
* Suggested split if the reviewer prefers smaller PRs: PR-C1 = migration 017 + namespace guard + identity-kind service (DB reviewers), PR-C2 = SSO chain + protocol hardening + docs (security reviewers). Not done mechanically to avoid rewriting history.

## 2. Security findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S1 | High | OAuth `state` was single-use but not bound to the browser: login CSRF (victim completes the attacker's login) | **Fixed**: HttpOnly SameSite=Lax cookie binding, digest-stored, burn-on-mismatch |
| S2 | High | OAuth code path could issue sessions as soon as SSO + endpoints were configured although MJU's protocol is unconfirmed | **Fixed**: `SSO_PROTOCOL_CONTRACT_CONFIRMED` gate, default off |
| S3 | Medium | Live provider fell back to Person-API claim names (`citizenID`) as the citizen-ID source | **Fixed**: explicit `SSO_NATIONAL_ID_CLAIMS` required for non-mock providers |
| S4 | Medium | Token response/userinfo shape not validated; `id_token` implicitly possible | **Fixed**: string `access_token`, Bearer `token_type`, JSON-object userinfo; `id_token` ignored |
| S5 | Medium | Session JWT algorithm not pinned on verify, no `jti` | **Fixed**: HS256 pinned, unique `jti` |
| S6 | Low | Handoff code in redirect URL could leak via Referer/cache | **Fixed**: `Referrer-Policy: no-referrer`, `Cache-Control: no-store` |
| S7 | Low | Unbounded in-memory state store | **Fixed**: cap 10 000 (eviction can still be abused: see S8) |
| S8 | Medium | **No rate limiting anywhere** (`/auth/sso/login`, `/callback`, `/exchange`) | **Open**: enforce at the reverse proxy before any live probe |
| S9 | Medium (policy) | While the subject contract is unconfirmed a session rests on the provider's citizen-ID claim alone; a CANDIDATE link is promoted to APPROVED by `system:sso` on a verified login, which differs from the earlier "candidate cannot authenticate" rule | **Open - owner decision**: accept national-ID-only sessions until the subject contract is confirmed, or require `SSO_SUBJECT_CONTRACT_CONFIRMED` for sessions |
| S10 | Low | Logout revokes the refresh token only; the access JWT lives up to 15 min | Accepted / document |
| S11 | Low | State/handoff stores are in memory (restart loses logins; no multi-instance) | Open before scale-out |
| S12 | Medium | Migration 017 needs `SUPER` or `log_bin_trust_function_creators=1` under binlog (error 1419) and runs as its `DEFINER` (dropping that account breaks identifier writes, error 1449) | **Verified and documented**: `docs/MIGRATION_017_PRIVILEGES.md`; DBA decision required |
| S13 | Info | In userinfo-probe mode the 503 body shows field names and `****NNNN` masks to the browser | Accepted: probe is off by default, operator only |
| S14 | Info | Portal mode may not echo `state` at all (legacy bundle had no state check) | Open: if MJU cannot echo it, use cookie-only binding (design item, not implemented) |

## 3. Regression review

* `ssoStateStore.create/consume` changed (`consume` returns `{codeVerifier}|null`, takes a binding); `ssoService.beginLogin({browserBinding})` is mandatory for the OAuth path. All callers (controller, tests) updated. Portal and diagnostic modes are unchanged.
* `authenticate` pins HS256: tokens from `authService` and `ssoTokens` are HS256 (library default), so existing tokens remain valid. Tests for both paths pass.
* `.env.example` gains `SSO_PROTOCOL_CONTRACT_CONFIRMED=false` and `SSO_PKCE_METHOD=`; existing deployments keep SSO off, so nothing changes until an operator sets them.
* Backend suite is green (see report); the 4 skipped tests need a seeded MariaDB (unchanged).

## 4. Migration 017 review

DB-level atomic guard (claim table + triggers), idempotent, rollback and preflight present; verified on MariaDB 10.3 and 10.11 including binlog `ROW`/`STATEMENT`, TRIGGER-only, SUPER, no-TRIGGER and definer-removal cases. Residual risks: S12, numbering (section 1), triggers add a write cost (one claim insert/lookup per identifier write; negligible for this table size).

## 5. PII review

* Tracked files contain no value from `IDCardRaecsv2027.csv` (50 national IDs and 53 Thai names checked, counts only: 0 hits). 13-digit literals are synthetic test IDs; the CSV, `database/local/` and `.env` are git-ignored; secret scan passes.
* Scripts only write to git-ignored `database/local/`; the employee bundle holds HMAC lookups and `facescan_id`, never raw national IDs, and refuses plaintext rows.
* Diagnostics log field names/lengths and `****NNNN` masks only; no token or citizen ID in error messages.

## 6. Attendance vs SSO separation (verified)

Attendance eligibility = an active `facescan_id` only (`requiresMjuSso:false`); an MJU `personnel_id` alone does not grant it. SSO eligibility is a separate policy (`NOT_REQUIRED` for HIP). No onboarding script references identity-link tables or provider subjects (static test); only a verified callback creates a link.

## 7. Proposed PR description (PR-C, stacked on PR-B)

**Title:** SSO identity chain on the shared National ID contract: MJU/HIP identity kinds, atomic namespace guard (017), fail-closed SSO protocol

**Summary:** integrates the SSO identity chain with HMAC-only National ID resolution; adds migration 017 (facescan/personnel namespace claim); separates HIP attendance eligibility from MJU SSO; hardens the OAuth path (state binding, protocol/claim gates, token validation, HS256 pin) and keeps it OFF until MJU confirms the protocol.

**Out of scope / not done:** push, merge, migration on any real database, import, deploy, SSH, live SSO probe, real data.

**Test plan:** `npm test` (backend, with `RAE_QA_DB_PORTS` and `RAE_QA_BINLOG_PORTS` for the disposable MariaDB suites), `npx eslint src tests`, `node --test scripts/data-onboarding/*.test.mjs`, `node scripts/secret-scan.mjs`.

**Reviewer checklist:** S8, S9, S12 decisions; migration numbering with the facescan branch; MJU answers (`docs/SSO_PROTOCOL_EVIDENCE.md`).
