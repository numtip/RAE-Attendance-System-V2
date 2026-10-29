# SSO staging preparation — mock E2E, fail-closed probe, migrations and rollback

**Scope of this document:** staging *preparation* only. The owner approved staging preparation on
2026-10-29 (D-8) and explicitly did **not** approve a live MJU sign-in (D-5 open). Nothing in this
document contacts MJU, applies a migration to any shared database, or enables SSO anywhere.

**Related:** [`SSO_ACTIVATION_CHECKLIST.md`](./SSO_ACTIVATION_CHECKLIST.md) (the gate),
[`SSO_ACTIVATION_RUNBOOK.md`](./SSO_ACTIVATION_RUNBOOK.md) (the live run, blocked),
[`SSO_G02_LOGIN_BINDING.md`](./SSO_G02_LOGIN_BINDING.md) (the store).

---

## 1. What can be proven today, and what cannot

| Question | Answer | How |
|---|---|---|
| Does the approved-link gate refuse an e-mail identity? | **Yes** | test runner: `backend/tests/sso.test.js`, seven negative cases |
| Does a live callback mint a session without an approved link? | **No** | same suite; the gate is structural (ADR-004 in the standard repo) |
| Does a deployed staging container refuse SSO while the gates are closed? | **Yes** | the container runs `NODE_ENV=production` + `SSO_ENABLED=false`, so `/api/v1/auth/sso/*` fails closed |
| Can the full login round-trip run on staging without MJU? | **No** | the mock provider is a test double and is refused when `NODE_ENV=production` (`SSO_MOCK_PROVIDER_REFUSED`) — deliberately, so a double can never be a deployed identity provider |
| Anything at all about MJU's behaviour? | **No** | B-00…B-05 unanswered; see the standard's `PROVIDER_BLOCKERS.md` |

So "mock E2E on staging" means two different things and both are prepared:
**(a)** the full flow against the mock provider — runs in the test runner, which is where the
identity, replay, binding and CSRF behaviour is actually asserted; **(b)** a deployed staging
container probed to show it refuses everything while the gates are shut.

---

## 2. Mock E2E (test runner — no MJU, no database)

```bash
cd backend
npm ci
node --test tests/sso.test.js tests/ssoCallbackWiring.test.js \
             tests/ssoLoginBinding.test.js tests/ssoIdentityChain.test.js \
             tests/ssoStateStoreContract.test.js tests/ssoLoginAttemptStore.mariadb.test.js
```

Expected: everything passes; the MariaDB store suite reports **skipped** locally (it runs in CI's
`backend-mariadb` job, which brings up a real MariaDB 11.4 service).

The flow exercised is: `beginLogin` → portal redirect helper → callback with a code and a state →
state consumption bound to the browser cookie → provider exchange → **verified subject → approved
identity link → active employee** → rotated refresh token. Negative cases asserted: replayed
callback, missing or tampered binding cookie, unapproved/pending/revoked link, e-mail-only profile,
stale e-mail evidence, disabled employee, provider denial, timeout, malformed response.

Capturing evidence for a staging report: run with `--test-reporter=spec`, save the output outside
git, and record the commit SHA and the standard's contract version. Never capture a token, a
cookie value, an `ac` value, an e-mail address or an employee name.

---

## 3. Deployed staging container — fail-closed probe (allowed, no MJU)

`deploy/docker-compose.yml` sets `NODE_ENV: production` and `SSO_ENABLED: 'false'`. With that
configuration:

| Request | Expected |
|---|---|
| `GET /api/v1/auth/sso/login` | `403 SSO_DISABLED` |
| `GET /api/v1/auth/sso/callback?code=x&state=y` | `403 SSO_DISABLED` |
| `POST /api/v1/auth/sso/logout` (no bearer) | `401 UNAUTHORIZED` (the `authenticate` middleware) |
| Any of the above with `SSO_ENABLED=true` but the subject contract flag false | `503 SSO_SUBJECT_CONTRACT_UNCONFIRMED` |
| Mock provider configured in the container | `503 SSO_MOCK_PROVIDER_REFUSED` |

Three of these are asserted in the suite (`SSO HTTP routes stay closed by default`, the gate tests,
and the mock-in-production refusal). Probing the deployed container is still worth doing once,
because it proves the *deployed* environment variables match what the repository claims.

**Do not** set `SSO_ENABLED=true` on a shared staging host under this authorisation: that is
preparation, not a live sign-in, and it would need A-1…A-7 first.

---

## 4. Migration `028_sso_login_attempt` — apply and roll back (staging only)

**Nothing has been applied anywhere.** The table exists only as a file. Apply it only when
`SSO_LOGIN_ATTEMPT_STORE=mariadb` is chosen for a staging deployment.

Preconditions:
- a staging database only — production is frozen and out of scope;
- `SSO_ENABLED` may stay `false`: the table is inert until the login flow runs;
- a named operator and a window, because the apply and the rollback rehearsal are part of the
  staging evidence.

Apply:

```bash
# from the repo root, with the staging connection in the environment
npm run db:migrate                  # applies pending migrations in order, 028 included
npm run db:migrate                  # second run must apply nothing (idempotency check)
```

Then verify and rehearse the rollback, in this order:

```bash
# 1. the table exists and stores digests only (no plaintext state or binding value)
# 2. SSO_LOGIN_ATTEMPT_STORE=mariadb with the gates still closed -> still fails closed
# 3. rollback rehearsal
mysql "$STAGING_DB" < database/rollbacks/028_sso_login_attempt.down.sql
# 4. re-apply, so staging ends in the applied state
npm run db:migrate
```

Behaviour to confirm: a **missing** table must fail closed (`503`) rather than silently fall back
to process memory — that fallback is exactly what the table exists to remove.

---

## 5. Rollback of the whole feature (unchanged, and rehearsable without MJU)

| Layer | Action | Verified by |
|---|---|---|
| SSO off | `SSO_ENABLED=false` (the shipped default) | `SSO HTTP routes stay closed by default` test |
| Subject contract | `SSO_SUBJECT_CONTRACT_CONFIRMED=false` | gate tests |
| Callback registration | `SSO_CALLBACK_CONFIRMED=false` | gate tests |
| Attempt store | set `SSO_LOGIN_ATTEMPT_STORE=memory` for a single-process deploy, or roll back 028 | `ssoLoginAttemptStore` contract suite |
| Session | existing JWT/refresh tokens revoke through the normal path (`POST /auth/sso/logout`) | `securitySliceLockoutRevocation` suite |

Rehearse once on staging and record: the timestamp, the deployed SHA, the operator, the requests
sent and the exact responses. That record is the rollback evidence a reviewer will ask for.

---

## 6. What a real end-to-end staging sign-in still needs (blocked)

1. **B-00** — which integration model MJU supports (portal `ac` or OAuth2/OIDC). Nothing else is
   actionable until this is answered; the two repos in this project implement different models.
2. **B-01 / B-04** — the `ac` shape and the authoritative subject field.
3. **B-05** — a registered staging callback URL and a consenting test account.
4. **A-1…A-7** — the owner's authorisation for a live sign-in (D-5), plus where the redacted trace
   is stored.

Until all four exist, this document is as far as staging goes.
