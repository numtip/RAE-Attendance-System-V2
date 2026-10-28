# G-02 — login attempt binding and the shared store

**Status:** implemented on `feat/sso-standard-adapter` (PR #63), mock-tested and CI-tested.
**Not enabled anywhere.** SSO stays off by default; nothing here changes production.

---

## 1. The problem

Two gaps were recorded against the SSO login state store:

1. **No binding.** `create()` returned an opaque state with nothing tying it to the browser that
   started the login. MJU does not echo `state` (`docs/SSO_PROTOCOL_EVIDENCE.md`), so the state
   alone could not distinguish *the user who started this* from *anyone holding the value*.
2. **Process-local only.** A `Map` meant a restart forgot every pending login and a second
   instance never saw the first instance's state.

Consequence: login CSRF was bounded only by the state's secrecy and TTL, and a rolling deploy
could strand in-flight logins. Neither is acceptable for staging, and both would be worse in
production.

---

## 2. Decisions

### 2.1 Browser binding via an HttpOnly cookie

- A **server-generated** 32-byte value (`randomBytes(32).toString('base64url')`) is produced on
  every login. A client-supplied value is never adopted, so the binding itself cannot be fixed.
- Only its **SHA-256 digest** is stored server-side. The cookie carries the value; the database
  never does, so a leaked table cannot be replayed as a session.
- Cookie attributes: `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth/sso`, `maxAge` = attempt TTL.
  `Secure` is set when `NODE_ENV=production`.
  `SameSite=Lax` is required: the provider returns with a **top-level GET**, which Lax cookies
  accompany; `Strict` would drop the cookie on that redirect and break every login.
- `Secure` is *not* set in development because the dev server is plain HTTP and the browser would
  silently discard the cookie. This is a dev-only concession and is documented rather than hidden.
- The cookie is cleared **before** the token exchange, so a retry cannot reuse it, and again on
  logout so a half-finished login cannot be resumed after the user asked to sign out.

### 2.2 Binding is mandatory in production

`config.sso.requireLoginBinding` is `SSO_REQUIRE_LOGIN_BINDING === 'true'` **or**
`NODE_ENV === 'production'`. In production a missing binding makes `beginLogin` fail closed with
`SSO_STATE_BINDING_REQUIRED`, so a wiring regression cannot quietly disable the control.

Locally the flag is off by default so direct service-level tests can create unbound attempts; the
controller always supplies a binding, and unbound attempts are explicitly *not* satisfiable by
presenting one.

### 2.3 Shared store = MariaDB (no new service)

**Verified before deciding:** the pilot already has `mysql2`, `backend/src/db/pool.js`,
`database/migrations/`, and a `backend-mariadb` CI job running a real MariaDB 11.4 service.
Redis is not a dependency and adding one for a 10-minute attempt record would be new operational
surface for no gain. So the shared backend is **MariaDB**, table `sso_login_attempt`
(migration `028`, rollback `028_...down.sql`).

**Migration number:** `027` is deliberately reserved by
`backend/tests/employeeUidConstraintSql.test.js` for an approval-pending constraint proposal, and
`018`/`019` are reserved by draft PR #35 (durable `ac` replay). This table is therefore `028`.

### 2.4 Atomic single use

`consume()` runs in a transaction:

```sql
SELECT binding_digest, (expires_at > UTC_TIMESTAMP(3)) AS alive
  FROM sso_login_attempt WHERE state_digest = ? FOR UPDATE;
DELETE FROM sso_login_attempt WHERE state_digest = ?;
COMMIT;
```

`FOR UPDATE` serialises concurrent consumers, so two callbacks cannot both win — the second
blocks, then finds no row. A read-then-delete in JavaScript would let both see the row, which is
exactly the double login this store exists to prevent. The row is deleted on **every**
presentation, valid or not, so a wrong binding cannot be retried.

### 2.5 No silent fallback

Any database error other than "no row" becomes `503 SSO_LOGIN_STORE_UNAVAILABLE`. Falling back to
process memory would quietly restore the single-instance behaviour this change removes.
`SSO_LOGIN_ATTEMPT_STORE=memory` is still allowed for a single-process staging box, but it must be
stated explicitly, and it is **refused when SSO is enabled in production**.

---

## 3. Configuration

| Variable | Default | Notes |
|---|---|---|
| `SSO_LOGIN_ATTEMPT_STORE` | *(unset → `mariadb` when a pool exists, else `memory`)* | `mariadb` or `memory` |
| `SSO_LOGIN_BINDING_COOKIE` | `rae_sso_bind` | cookie name |
| `SSO_LOGIN_BINDING_TTL_MS` | `600000` (10 min) | attempt lifetime |
| `SSO_REQUIRE_LOGIN_BINDING` | `false`, **forced `true` in production** | fail closed without a binding |

---

## 4. What was NOT changed

- **G-03** (identity approval) and **G-04** (access-token revocation) are untouched. Both are
  already correct on `origin/main` and covered by existing tests; reimplementing them would risk
  weakening them.
- The portal `?ac=` token flow is not on `main`, so the binding currently protects the OAuth
  authorize path. The same store is reusable by the portal flow when it lands (PR #35 direction).
- No production deployment, migration application, config change or live MJU login.

---

## 5. Residual risk (unchanged, and still the largest)

The binding proves *this browser started a login here*. It does **not** prove *this callback
answers the request I made*. Inside a browser that has just started a login, an
attacker-supplied callback cannot be distinguished from the provider's. Only MJU echoing a
pass-through value closes that (provider blocker **B-06** / contract item C-10). This change
narrows the window; it does not close it, and no documentation here claims otherwise.

---

## 6. Evidence

| Check | Result |
|---|---|
| Backend suite | 208 tests — 194 pass, 0 fail, 14 skipped (DB-gated) |
| `ssoLoginBinding` (new) | 13 pass — cookie attributes, randomness, tamper, single use, concurrency, logout |
| `ssoStateStoreContract` | 12 pass — binding, expiry, shared-instance, legacy backends |
| `ssoLoginAttemptStore.mariadb` (new) | 7 tests, skipped locally (no Docker), **run in CI's `backend-mariadb` job** |
| Root tooling | 19 pass |
| ESLint (`src`, `tests`) | clean |
| Secret scan | clean (288 tracked files) |
