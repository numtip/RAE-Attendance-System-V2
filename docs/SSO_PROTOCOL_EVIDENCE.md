# MJU SSO protocol evidence (CONFIRMED / INFERRED / UNKNOWN)

Scope: what the repository's docs, config and code prove about the MJU SSO protocol, and what the backend therefore does. **MJU SSO is not assumed to be OIDC.** No live call, secret, token or real identity was used.

Evidence sources: `docs/SSO_CONTRACT_CONFIRMATION.md` (public page observation 2026-10-01), `docs/SSO_READINESS.md`, `docs/MJU_SSO_SUBJECT_EVIDENCE_PACK.md`, `docs/SSO_ACTIVATION_RUNBOOK.md`, `.env.example`, `backend/src/services/sso/*`.

## 1. Evidence matrix

| # | Item | Status | Evidence | What the backend does |
|---|---|---|---|---|
| 1 | V2 client registered; client id is a public value | CONFIRMED | `SSO_READINESS.md` registration table | uses it only as `cid`; not an authentication secret |
| 2 | Callback URL registered | CONFIRMED | registration record | route exists, session issuing is gated (below) |
| 3 | Portal sign-in `signin.aspx?cid=<client id>` is an HTML login form (ASP.NET WebForms) | CONFIRMED | public page | `GET /auth/sso/login` redirects there with only `cid` when `SSO_SIGNIN_URL` is set |
| 4 | Sign-out `signout.aspx?cid=` redirects (302) to the registered after-signout URL | CONFIRMED | public page | logout returns that URL; adds no parameters |
| 5 | Callback is a `GET` with one query field `ac` (32 chars), no body | CONFIRMED as a *recorded shape*; **not independently observed** (`SSO_CONTRACT_CONFIRMATION.md` says no completed sign-in was observed, `SSO_READINESS.md` records the shape) | docs disagree on provenance | treated as unproven: portal-mode callback returns `503 SSO_NOT_READY`; `ac` is never identity |
| 6 | Meaning/validation of `ac` | UNKNOWN | - | never used, stored or logged (names/lengths only in diagnostic mode) |
| 7 | OAuth2 authorization-code exchange (authorize/token endpoints) | **INFERRED** from donor code and the legacy error name `missing_code` | `SSO_CONTRACT_CONFIRMATION.md` row "`missing_code` implies an OAuth code" | fail-closed: `SSO_PROTOCOL_CONTRACT_CONFIRMED=false` (default) => `503 SSO_NOT_READY` on login and callback |
| 8 | Token endpoint URL / request shape / client secret | UNKNOWN (client secret: NO EVIDENCE) | no value anywhere | no guessed URLs; empty in `.env.example` |
| 9 | Userinfo endpoint and claims | UNKNOWN | - | only after row 7 is confirmed; profile must be a JSON object |
| 10 | OIDC (`id_token`, issuer, audience, JWKS, nonce, discovery) | **UNKNOWN - not assumed** | the `openid` scope default is donor-code text, not evidence | an `id_token`, if ever returned, is ignored (never validated, never an identity source) |
| 11 | OAuth `state` echoed by MJU | UNKNOWN (the legacy bundle did not implement a state check) | `SSO_READINESS.md` line 24, runbook line 16 | state + cookie binding implemented for the OAuth path only; see 3 |
| 12 | PKCE | UNKNOWN | - | not implemented (out of the MVP, see `docs/SSO_MVP.md`) |
| 13 | Authoritative immutable subject claim | UNKNOWN | evidence pack C1-C3 | `extractVerifiedSubject` stays `unknown` until `SSO_SUBJECT_CONTRACT_CONFIRMED=true` |
| 14 | Citizen-ID claim name on SSO userinfo | UNKNOWN (`citizenID` / `citizen_id` are Person-API names) | `mjuNationalIdAdapter.js` comment | live provider needs an explicit `SSO_NATIONAL_ID_CLAIMS`; otherwise `503 SSO_NOT_READY` |
| 15 | Callback signature / hash | UNKNOWN | - | nothing is trusted from the callback query except `code`/`state`/`error` |
| 16 | Provider session / logout semantics | CONFIRMED for the IdP URL, UNKNOWN for pairing | - | revoke our refresh token; return `signoutUrl` |

Update 2026-10-09: rows 5-9 and 14 are partly answered by MJU's vendor sample (section 1a): the redemption is `POST token.aspx` with JSON `{clientID, code}` and the response carries `citizenID` / `humanID` / `personID`. Rows 7 and 10 stay as they are: the sample is **not** OAuth2/OIDC (no secret, no `grant_type`, no userinfo, no `id_token`). Written confirmation is still outstanding (section 4a).

## 1a. Vendor sample (`docs/sampleCallback.aspx`, `docs/sampleCallback.aspx.vb`, file dates 2025-04-08)

An ASP.NET VB callback page that MJU supplies as an example for client developers. It is **evidence of MJU's intended flow, not a signed contract**. The files stay untracked (they contain an example client id; the comment in the code says to replace it with the client's own). Everything below was read literally from them.

**Taken from the sample (SAMPLE-OBSERVED)** and implemented in `mjuTokenClient.js` / `ssoService.js` behind `SSO_MJU_TOKEN_FLOW=true` (default off):

| # | Sample fact | In our code |
|---|---|---|
| S1 | Sign-in URL `https://sso.mju.ac.th/signin.aspx?cid=<clientID>` | `buildCidUrl` (already used for login) |
| S2 | The callback reads one query value `ac` and sends it as `code` | `?ac=` is read in the controller; it is a one-shot credential, never an identity |
| S3 | Redemption is `POST https://sso.mju.ac.th/token.aspx`, `Content-Type: application/json`, body = JSON of `{ clientID, code }` | `POST` with exactly those two properties; `SSO_TOKEN_URL` is operator-set (not hard-coded) |
| S4 | No client secret, no `Authorization` header, no `grant_type`, no `redirect_uri`, no `state`, no PKCE, no userinfo call, no `id_token` | none is sent or accepted; no OAuth/OIDC step is added |
| S5 | Only HTTP 200 is success; any other status or exception is logged and the user is sent back to `signin.aspx` | 4xx => `401 SSO_CODE_INVALID`; 5xx/network => `502 SSO_PROVIDER_ERROR`; timeout => `504`; we do **not** redirect back to MJU |
| S6 | The 200 body is JSON deserialized into: `citizenID`, `name`, `pictureUrl`, `humanID`, `personID`, `studentID`, `studentCode`, `nationID`, `titleName`, `firstName`, `lastName`, `titleNameEn`, `firstNameEn`, `lastNameEn`, `position`, `e_mail`, `personnelPhoto` | only `citizenID` and one subject field are read; every other field is dropped |
| S7 | `personID` / `studentID` are used only if numeric, and decide which dashboard opens | `personID` may be selected as subject (`SSO_SUBJECT_CLAIM=personID`); `studentID` is ignored |

**What our adapter adds that the sample does not do** (the sample has none of these):

| Control | Behaviour |
|---|---|
| Browser callback binding | `/login` sets an HttpOnly `SameSite=Lax` cookie and registers its digest; the callback must present it, once, within 10 min, else `403 SSO_STATE_INVALID` and MJU is **not** called. Because MJU does not echo `state`, this binds the callback to *a browser that started a login here*, not to the exact request; residual risk and the question to MJU are in section 4a |
| `ac` replay guard | each `ac` is tried once per process (stored as SHA-256 digest, 1 h); a repeat => `403 SSO_CODE_REPLAY` before any call. In-memory: use a shared store for more than one instance |
| Validate before session | non-2xx / not JSON / not an object / empty => no session. Subject **and** `citizenID` required: nothing usable => `401 SSO_CODE_INVALID`; one missing => `502 SSO_RESPONSE_INCOMPLETE`; subject = `ac`, = the citizen ID, containing its digits, e-mail-shaped or malformed => `403 SSO_SUBJECT_INVALID`; malformed citizen ID => `403 SSO_NATIONAL_ID_INVALID` (a linked subject never falls back to subject-only) |
| Identity mapping | `citizenID` is looked up through the protected HMAC (`national_id` -> `employee_uid`); the raw ID is never stored, logged, returned or used as a subject. Name, `e_mail`, photo, `personID`/`studentID` never select an employee (the e-mail is not even stored as a link snapshot) |
| S9 | a session still needs the verified subject (`SSO_SUBJECT_CONTRACT_CONFIRMED=true`), and a first-login link is created only when subject and citizen ID resolve in the same login; subject linked to another employee => `409 IDENTITY_SUBJECT_CONFLICT` |

**Which field is the subject.** The sample does not say. Default is `humanID` (present for staff and students in the model, so most likely person-level); `personID` is selectable; `citizenID` is refused as a subject on purpose (it would put a National ID into the links table). The choice must be confirmed by MJU before `SSO_SUBJECT_CONTRACT_CONFIRMED=true`.

**Still not confirmed by the sample (UNKNOWN)** and gated by `SSO_PROTOCOL_CONTRACT_CONFIRMED` / `SSO_SUBJECT_CONTRACT_CONFIRMED`: see section 4a.

## 2. Fail-closed gates now in code (all default OFF)

| Gate | Env | Effect when not satisfied |
|---|---|---|
| SSO enabled | `SSO_ENABLED` | `403 SSO_DISABLED` |
| Callback registered | `SSO_CALLBACK_CONFIRMED` | `503 SSO_NOT_READY` |
| **Protocol (token/userinfo) contract** | `SSO_PROTOCOL_CONTRACT_CONFIRMED` | `503 SSO_NOT_READY` on login and callback (mock provider exempt, refused in production) |
| **Citizen-ID claim name** | `SSO_NATIONAL_ID_CLAIMS` (non-empty) | `503 SSO_NOT_READY` before any identity lookup |
| Subject contract | `SSO_SUBJECT_CONTRACT_CONFIRMED` | subject unknown: no provider link is created or used |
| Production safety | `NODE_ENV=production` | mock provider and non-https endpoints refused |
| MJU portal flow (section 1a) | `SSO_MJU_TOKEN_FLOW` (+ `SSO_TOKEN_URL`, `SSO_PROTOCOL_CONTRACT_CONFIRMED`, `SSO_SUBJECT_CONTRACT_CONFIRMED`, `SSO_SUBJECT_CLAIM`) | flag off: portal callback stays `503 SSO_NOT_READY`; flag on without the two confirmations: `503` on login / `403 SSO_SUBJECT_NOT_VERIFIED` after exchange |

## 3. Controls implemented for the OAuth path (only reachable after the gates above)

| Control | Implementation | Test |
|---|---|---|
| Login-CSRF / state binding | `state` is single use, 10 min, stored with a SHA-256 digest of a server-generated random binding that the controller sets as an `HttpOnly; SameSite=Lax; Path=/api/v1/auth/sso` cookie (`Secure` in production). A state presented without the matching cookie is rejected **and burned** | `ssoMvp.test.js` |
| Fixation | binding is always generated server side; a client-supplied cookie is never adopted; fresh refresh token + unique JWT `jti` per login; handoff code single use (45 s) | `ssoMvp.test.js` |
| Replay / expiry | single-use state, TTL | `ssoMvp.test.js` |
| Callback input validation | `code`/`state` must be bounded strings; provider error text truncated | same |
| Token substitution | userinfo is called only with the access token of this exchange; `token_type` must be Bearer when present; `id_token` and query-supplied token/claims ignored | same |
| Session token signature | HS256 pinned on sign and verify; `none`, other algorithms, tampering, expiry rejected | same |
| Handoff leakage | callback/exchange send `Cache-Control: no-store`, `Referrer-Policy: no-referrer` | controller test |

Not implemented because it cannot be proven from the provider contract or is outside the MVP: PKCE, nonce/`iss`/`aud`/JWKS, callback signature checks. The portal (`ac`) exchange is implemented from the vendor sample (section 1a) behind `SSO_MJU_TOKEN_FLOW`, default off.

## 3a. Evidence search log
Besides this repository, other local projects under `G:\ProjectAI` were searched (read-only) for MJU SSO client code or captured callbacks: none exist. The only lead is a separate, working MJU SSO consumer on the VPS (`raemju-project/metabase-sso-deploy`, mentioned in `rae-nextjs-main/ARCHITECTURE.md`); reading it needs the SSH approval gate and is the fastest way to learn the real contract if MJU is slow to answer.

## 4a. Still to ask MJU after reading the vendor sample (minimum for a first live login)

The sample answers the *shape* of questions 1-2, 4 and part of 7 in section 4 (flow, JSON request, no secret, property names). It does **not** answer:

1. Is `ac` single use, and what is its lifetime? What does `token.aspx` return for an expired, used or wrong-client code (HTTP status and body)? We treat any 4xx as "code refused" and a 200 with no identity as "code refused".
2. Which field is the stable, never-reused subject: `humanID`, `personID` or `citizenID`? Is it present for staff, contractors and students? (Default in code: `humanID`.)
3. Is `citizenID` always the plain 13-digit value? Written approval to release it to RAE.
4. Is the response signed, or is TLS the only protection? Is `token.aspx` restricted by IP (egress addresses)? Is our own `clientID` (not the sample's) enough with no secret?
5. `state` is not echoed. Is there any way to bind the callback to the request that started it (e.g. a pass-through value), or is `ac` bound to the browser session at MJU?
6. Is a staging callback URL and a consenting test account available?
7. Does `signout.aspx?cid=` accept a return URL? (unchanged from section 4, question 11)

Until 1-4 are answered in writing, keep `SSO_PROTOCOL_CONTRACT_CONFIRMED` and `SSO_SUBJECT_CONTRACT_CONFIRMED` off in any shared environment; set them only for a controlled, single-account staging probe with the owner's approval.

## 4. Questions for MJU IT (send before any staging probe)

Client: RAE Attendance System V2 (registered client; id is in `.env.example`).

1. After a successful sign-in, what exactly does MJU send to the registered callback (method, query/form/redirect, field names, lifetime and single-use of `ac`)?
2. Is `ac` a one-time ticket? How is it redeemed (endpoint URL, method, parameters, authentication of our server) and what does the redemption return?
3. Is the flow OAuth 2.0 authorization code, OpenID Connect, or a proprietary ticket exchange? If OIDC: issuer, discovery URL, JWKS URL, signing algorithms, `aud`, `nonce` support.
4. Is a client secret / API key required? Which request carries it, how is it rotated?
5. Is the `state` parameter accepted and returned unchanged?
6. Which field is the authoritative, immutable, never-reused user subject? Is it stable across sign-ins and across name/e-mail changes?
7. Does the response contain the Thai citizen ID? Exact claim name, format (13 digits, no separators?), and is it present for every account type (staff, contractors, students)?
8. Is e-mail always present and verified? Is it ever reassigned to another person?
9. Is the callback or the response signed or hashed? How is it verified?
10. Which accounts exist for contractors? Are contractors without an MJU personnel record able to sign in (we do not require it)?
11. Sign-out: does `signout.aspx` end the MJU session only, or also notify us? Can the after-signout URL carry a parameter?
12. Session lifetime at MJU, forced re-authentication (`prompt`/`max_age` equivalent), and account-disabled propagation.
13. Is there a sandbox/test account and a sample payload that contains no production password or real citizen ID?
14. Rate limits and IP allow-listing for the token/userinfo endpoints; required egress IPs.
15. Redirect/callback URL matching: exact match? Are multiple callback URLs (staging) allowed for the same client?

(ภาษาไทย: ขอให้ MJU IT ตอบเป็นลายลักษณ์อักษรและบันทึกลง `MJU_SSO_SUBJECT_CONTRACT_RESPONSE_TEMPLATE.md` ก่อนตั้งค่า `SSO_PROTOCOL_CONTRACT_CONFIRMED=true`)
