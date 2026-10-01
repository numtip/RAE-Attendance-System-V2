# SSO reuse plan

## What was verified

The December 2025 donor image mounts:

- `GET /api/auth/sso/login`
- `GET /api/auth/sso/callback`
- `GET /api/auth/sso/me`
- `POST /api/auth/sso/logout`

The production bundle does not call those paths. It navigates to `/attendance/api/auth/sso/login` and calls `/attendance/api/auth/sso/me` and `/attendance/api/auth/sso/logout`. Nginx serves `/attendance/` as the Vue app, so those URLs return HTML.

The donor config reads `SSO_ENABLED`, `SSO_ENDPOINT`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, and `SSO_CALLBACK_URL`. The legacy host environment also has `SSO_AUTHORIZATION_URL`, `SSO_TOKEN_URL`, `SSO_USER_INFO_URL`, and `SSO_REDIRECT_URI`. Those extra names were not read by the donor config module. No secret values are recorded here.

The bundle expects `/auth/sso/me` JSON of the form `{ success: true, data: { ...user } }`.

## V2 decision

REWRITE the HTTP surface to:

- `GET /api/v1/auth/sso/login`
- `GET /api/v1/auth/sso/callback`
- `GET /api/v1/auth/sso/me`
- `POST /api/v1/auth/sso/logout`

REFERENCE the donor flow: start login by redirecting to MJU, finish on the callback, then issue the same V2 access and refresh tokens used by password login. Map the MJU user onto `employees.email` or `employee_identifier`. If no employee row matches, fail closed.

Do not keep `/attendance/api/*`.

## Before SSO can work

1. Register the new callback URL with MJU. The legacy callback URL is not assumed to match `/api/v1/auth/sso/callback`.
2. Put client id and secret in the V2 environment, not in git.
3. Confirm which host fields are the authorization, token, and user-info URLs. The donor's single `SSO_ENDPOINT` and the host's split URLs were not proven to be the same contract.
4. Keep `SSO_ENABLED=false` until that confirmation exists.

Release 1 routes are reserved and return `501` until that work is done.
