# MJU SSO contract confirmation

Reviewed 2026-10-01 from public pages and the V2 repository. No username or password was submitted. Runtime stays `SSO_ENABLED=false`.

Sources:

- V2 code and docs on `main` (`ssoService.js`, `SSO_READINESS.md`, `SSO_REUSE_PLAN.md`)
- Public legacy app `https://raeservice.mju.ac.th/attendance/` and bundles `index-78450XmL.js`, `LoginSSOView-DYfn6qI-.js`
- Public pages `https://sso.mju.ac.th/signin.aspx?cid=a46a0b5374b4404a9f71a2397dcab283` and `https://sso.mju.ac.th/signout.aspx?cid=a46a0b5374b4404a9f71a2397dcab283`

The legacy bundle `cid` is a different 32-character hex value. It is not the V2 client id.

## Matrix

| Contract item | Status | Evidence | V2 action |
|---|---|---|---|
| Sign-in URL | CONFIRMED | Registered URL. `GET /api/v1/auth/sso/login` redirects to `signin.aspx` with only `cid` when SSO is enabled. | Keep the cid redirect. Leave `SSO_ENABLED=false`. |
| Sign-in methods | CONFIRMED | The public MJU page offers Microsoft 365, ThaID, MJU Mobile App, and MJU username/password. | V2 does not collect or check those credentials. MJU authenticates. V2 starts at the callback. |
| Sign-out URL | CONFIRMED | `signout.aspx?cid=<client id>` returned **302** to `https://raeservice.mju.ac.th/attendance-v2/`. | Logout JSON may include that URL. Do not append extra parameters. |
| Callback URL | CONFIRMED | Registered webhook `https://raeservice.mju.ac.th/api/v1/auth/sso/callback`. | Keep the route. Do not accept a session from it yet. |
| Callback shape | CONFIRMED | Human sign-in returned `GET` with one query field `ac`. Length 32. No request body. The raw value was not stored. No V2 JWT was issued. | Accept only a later proven exchange. Until then return `SSO_NOT_READY`. |
| Meaning of `ac` | UNKNOWN | The name is confirmed. It is not evidence of an authorization code, access token, or ticket. | Do not exchange `ac` at a guessed URL. |
| `code` / ticket / `sso_token` on this callback | CONFIRMED absent | The captured query had only `ac`. Legacy UI `sso_token` is a different app's query after its own server responds. | Do not copy `sso_token` into a V2 session. |
| Token endpoint | UNKNOWN | Not present in the public sign-in page, the legacy bundle, or a registered URL. Donor docs name `SSO_TOKEN_URL` / `SSO_ENDPOINT` without values. | Do not call a guessed URL. |
| Userinfo endpoint | UNKNOWN | Same as token endpoint. No `userinfo` string in the public sign-in page or legacy SSO bundle. | Do not call a guessed URL. |
| Client secret / API key | NO EVIDENCE | Sign-in form has no secret or API-key field. V2 git secret is empty. Donor code has a `SSO_CLIENT_SECRET` setting with no recorded value. | Do not invent a secret. Keep `SSO_CLIENT_SECRET` empty. |
| Identity claim | UNKNOWN | V2 code would match `email`, then `mail`, then `preferred_username`, but MJU has not shown a claim. Sign-in uses `usernameTextBox`, which is not proof of the callback field. | Do not map username or employee code until MJU confirms the field. Unknown users stay denied. |
| Email guaranteed | UNKNOWN | No profile payload was returned. | Keep fail-closed if email is absent. |
| Callback signature / hash | UNKNOWN | No signature field or hash check appears on the public pages or in the legacy bundle. | Do not assume the callback is unsigned, and do not invent a hash. |
| Browser cookies on callback | CONFIRMED names only | The browser sent MJU-related cookies, including `ses_person_citizen`. Values were not stored. | Do not treat a cookie as the user identity. |
| Logout semantics | CONFIRMED for the IdP URL; UNKNOWN for app session pairing | Unauthenticated `signout.aspx?cid=` redirects to `/attendance-v2/`. Legacy UI clears `localStorage`, POSTs its own logout, then opens sign-out. | V2 revokes its own refresh token only after a real V2 session exists. No session was issued. |
| Error query on the legacy UI | CONFIRMED as legacy UI only | `LoginSSOView` reads `error`: `missing_code`, `sso_failed`, `user_not_found`, `sso_disabled`, `sso_config_error`, plus `details` for `user_not_found`. | Do not treat those strings as the MJU webhook contract. |
| `missing_code` implies an OAuth `code` | INFERRED | The error name suggests the legacy server expected something it called a code. The bundle does not show the inbound MJU query. | Ask MJU. Do not implement a code exchange from this name alone. |

## Legacy search for `ac`

Public Attendance bundles (35 script files, including `index-78450XmL.js` and `LoginSSOView-DYfn6qI-.js`) contain `sso_token` and `missing_code`. They do not contain a callback field named `ac`, and they do not call an endpoint that resolves `ac`. Donor docs name `SSO_ENDPOINT`, `SSO_TOKEN_URL`, and `SSO_USER_INFO_URL` with no values and no mention of `ac`. `citizen_id` appears only in a legacy CSV facescan-mapping screen. That is not an SSO identity claim.

No token endpoint, userinfo endpoint, or client secret was found for `ac`.

## Session rule

Issue a V2 session only after this chain is proven:

`ac` → validated MJU identity → active V2 employee → RBAC scope

Anything else stays fail-closed.

## What V2 will not do yet

- Enable SSO in production. `SSO_ENABLED=false` and `SSO_CALLBACK_DIAGNOSTIC=false`.
- Issue an access JWT or refresh token from `ac`.
- Copy the legacy `sso_token` into a V2 session.
- Guess what `ac` means, or guess a token, userinfo, claim, or signature field.

`SSO_CALLBACK_DIAGNOSTIC=true` is off by default. When set, and only when `SSO_ENABLED=true`, the callback returns `503` `SSO_NOT_READY` with field `name`, `type`, and `length`. Raw values are not included. Remove the flag after the contract is confirmed.
