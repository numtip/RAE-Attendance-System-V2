# Security baseline

- Do not commit `.env`, keys, tokens, database dumps, or service-account files.
- `.env.example` keeps secret fields empty.
- V2 does not read or write the legacy production database in this bootstrap.
- The development server binds `127.0.0.1:3210` only.
- SSO client secrets stay in the operator environment. The callback URL for V2 must be registered with MJU before SSO is enabled.
- `scripts/secret-scan.mjs` runs in CI and must pass before a branch is pushed.
- See `docs/SECURITY_BASELINE.md` for the application rules that Release 1 must implement.
