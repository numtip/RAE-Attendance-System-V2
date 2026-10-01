# MJU SSO contract confirmation

Reviewed 2026-10-01 from public pages and the V2 repository. No username or password was submitted. Runtime stays `SSO_ENABLED=false`.

**MJU subject contract is still UNKNOWN;** `backend/src/services/sso/mjuSubjectAdapter.js` is fail-closed (`extractVerifiedSubject` → `status: unknown`) until MJU documents the immutable subject claim and operators set `SSO_SUBJECT_CONTRACT_CONFIRMED=true`. Callback query field `ac` (32 chars) is **not** treated as identity.

Integration gate checklist: `docs/SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md`.

Sources:

- V2 code and docs on `main` (`ssoService.js`, `SSO_READINESS.md`, `SSO_REUSE_PLAN.md`)
- Public legacy app `https://raeservice.mju.ac.th/attendance/` and bundles `index-78450XmL.js`, `LoginSSOView-DYfn6qI-.js`
- Public pages `https://sso.mju.ac.th/signin.aspx?cid=a46a0b5374b4404a9f71a2397dcab283` and `https://sso.mju.ac.th/signout.aspx?cid=a46a0b5374b4404a9f71a2397dcab283`

The legacy bundle `cid` is a different 32-character hex value. It is not the V2 client id.

## Matrix

| Contract item | Status | Evidence | V2 action |
|---|---|---|---|
| Sign-in URL | CONFIRMED | Registered URL. `GET /api/v1/auth/sso/login` redirects to `signin.aspx` with only `cid` when SSO is enabled. | Keep the cid redirect. Leave `SSO_ENABLED=false`. |
| Sign-in page | CONFIRMED | Public HTML form `POST ./signin.aspx?cid=<client id>`. Inputs: `usernameTextBox`, `passwordTextBox`, plus ASP.NET `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, `confirmInsecureLoginHidden`. | Do not submit credentials. Do not treat this form as an OAuth authorize URL. |
| Sign-out URL | CONFIRMED | `signout.aspx?cid=<client id>` returned **302** to `https://raeservice.mju.ac.th/attendance-v2/`. | Logout JSON may include that URL. Do not append extra parameters. |
| Callback URL | CONFIRMED | Registered webhook `https://raeservice.mju.ac.th/api/v1/auth/sso/callback`. | Keep the route. Do not accept a session from it yet. |
| Callback query parameters | UNKNOWN | No completed sign-in was observed. The public sign-in page does not name a webhook payload. | Fail closed with `SSO_NOT_READY`. Optional diagnostic mode records names and lengths only. |
| `code` / ticket / token on the callback | UNKNOWN | Not observed. Legacy UI reads a query parameter named `sso_token` after its own server responds. That is not a V2 callback sample. | Do not accept `sso_token` as a V2 session. |
| Token endpoint | UNKNOWN | Not present in the public sign-in page, the legacy bundle, or a registered URL. Donor docs name `SSO_TOKEN_URL` / `SSO_ENDPOINT` without values. | Do not call a guessed URL. |
| Userinfo endpoint | UNKNOWN | Same as token endpoint. No `userinfo` string in the public sign-in page or legacy SSO bundle. | Do not call a guessed URL. |
| Client secret / API key | NO EVIDENCE | Sign-in form has no secret or API-key field. V2 git secret is empty. Donor code has a `SSO_CLIENT_SECRET` setting with no recorded value. | Do not invent a secret. Keep `SSO_CLIENT_SECRET` empty. |
| Identity claim | UNKNOWN | V2 code would match `email`, then `mail`, then `preferred_username`, but MJU has not shown a claim. Sign-in uses `usernameTextBox`, which is not proof of the callback field. | Do not map username or employee code until MJU confirms the field. Unknown users stay denied. |
| Email guaranteed | UNKNOWN | No profile payload was returned. | Keep fail-closed if email is absent. |
| Callback signature / hash | UNKNOWN | No signature field or hash check appears on the public pages or in the legacy bundle. | Do not assume the callback is unsigned, and do not invent a hash. |
| Session cookie from MJU | UNKNOWN | Legacy V2-unrelated UI sends `withCredentials` to `/attendance/api/auth/sso/me` and also stores `sso_token` in `localStorage`. That is the legacy app, not an MJU cookie on the V2 callback. | Do not create a V2 cookie from the callback. |
| Logout semantics | CONFIRMED for the IdP URL; UNKNOWN for app session pairing | Unauthenticated `signout.aspx?cid=` redirects to `/attendance-v2/`. Legacy UI clears `localStorage`, POSTs its own logout, then opens sign-out. | V2 revokes its own refresh token only after a real V2 session exists. No session was issued. |
| Error query on the legacy UI | CONFIRMED as legacy UI only | `LoginSSOView` reads `error`: `missing_code`, `sso_failed`, `user_not_found`, `sso_disabled`, `sso_config_error`, plus `details` for `user_not_found`. | Do not treat those strings as the MJU webhook contract. |
| `missing_code` implies an OAuth `code` | INFERRED | The error name suggests the legacy server expected something it called a code. The bundle does not show the inbound MJU query. | Ask MJU. Do not implement a code exchange from this name alone. |

## What V2 will not do yet

- Enable SSO in production.
- Issue an access JWT or refresh token from the portal callback.
- Copy the legacy `sso_token` into a V2 session.
- Guess token, userinfo, claim, or signature fields.

`SSO_CALLBACK_DIAGNOSTIC=true` is off by default. When set, and only when `SSO_ENABLED=true`, the callback returns `503` `SSO_NOT_READY` with field `name`, `type`, and `length`. Raw values are not included. Remove the flag after the contract is confirmed.
