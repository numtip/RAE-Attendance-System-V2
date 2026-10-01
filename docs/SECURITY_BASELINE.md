# Security baseline

## Secrets

- Secret values stay in the environment.
- `.env.example` is empty for `DB_PASSWORD`, `JWT_SECRET`, and `SSO_CLIENT_SECRET`.
- CI runs `scripts/secret-scan.mjs`.
- Do not commit dumps, refresh tokens, password hashes, national identifiers, or Canva tokens.

## HTTP

- One namespace: `/api/v1/`.
- JSON errors use `success: false` and a stable `error.code`.
- `x-powered-by` is disabled.
- JSON body limit is 1 MB.
- The process listens on loopback port `3210` during development. It does not bind `3000` or `3100`.

## Auth rules for the next implementation

- Hash passwords with a current password hash already stored in `employees.password_hash`. Do not add a second password column in this phase.
- Compare in constant time.
- Honor `login_attempts` and `locked_until` before a new write policy is approved. If the table is read-only, lockout updates wait.
- Access tokens are short lived (`JWT_EXPIRES_IN`, default 15 minutes).
- Refresh tokens are stored so they can be revoked. Prefer storing a hash. The current `refresh_tokens.token` column is varchar(500).
- SSO fails closed when the MJU identity does not match an employee.
- Do not log raw tokens, passwords, or `national_id` values.

## Data

- Profile responses omit `password_hash`.
- Leave responses omit `national_id_encrypted` and `raw_data` unless a later admin contract says otherwise.
- `ERROR 1932` on `employees` blocks live reads. Do not bypass it by copying a dump into the repo.

## Production

This bootstrap does not change production files, services, nginx, or database contents.
