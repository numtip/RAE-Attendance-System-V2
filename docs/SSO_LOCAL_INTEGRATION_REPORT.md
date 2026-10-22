# MJU SSO — local integration status and live-test prerequisites

**Date:** 2026-10-21 · **Workstream:** C (local only) · **Gate:** `SSO_LIVE_TEST_REQUIRED`
**Production:** **FROZEN.** No live MJU request was made, no VPS was touched, no SSO was activated.

> **Scope.** This report covers what can be verified **locally** from the reference files in `sso/` plus the
> existing Node/Vue implementation. Everything below about the wire protocol is **evidence from the vendor
> sample**, not a confirmed contract: no MJU-side confirmation has been obtained, and the code deliberately
> refuses to guess (see §2.2).

---

## 1. Registered values (`sso/client_list.txt`)

| Item | Value | Note |
|---|---|---|
| Application | RAE Attendance System V2 | |
| Client ID | `a46a0b5374b4404a9f71a2397dcab283` | **public identifier**, not a secret. Fine in docs, must not be confused with the sample's ID. |
| Webhook / callback URL | `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` | registered, `https` only |
| After-signout URL | `https://raeservice.mju.ac.th/attendance-v2/` | the only landing origin RAE V2 accepts |
| Signin URL | `https://sso.mju.ac.th/signin.aspx?cid=<clientId>` | |
| Signout URL | `https://sso.mju.ac.th/signout.aspx?cid=<clientId>` | |

**The sample's Client ID is different** (`9c04…`, hard-coded in `sampleCallback.aspx.vb` and
`sampleSignout.aspx.vb`). Reusing it would authenticate against another application's registration.
`ssoSignout.assertNotSampleClientId()` now rejects it at runtime, so the mistake fails loudly.

## 2. Signin / callback (C1)

### 2.1 What the vendor sample says

| Element | Sample (`sso/sampleCallback.aspx.vb`) | RAE V2 today |
|---|---|---|
| Callback parameter carrying the code | **`ac`** — `Page.Request.QueryString("ac")` | reads **`code`** (`ssoController.js:18`) |
| Token exchange | `POST https://sso.mju.ac.th/token.aspx`, JSON body `{ clientID, code }` | OAuth-shaped: `oauthProvider.exchangeCode(...)` with `client_id`/`client_secret`/`code`/redirect |
| Client authentication | **none** — no secret, no `grant_type` | requires `clientSecret` in `oauthConfigReady` |
| `state` / CSRF | **absent** in the sample | RAE V2 requires it (`ssoStateStore.consume`) |
| Response fields | `citizenID`, `humanID`, `personID`, `studentID`, `name`, `pictureUrl`, `eMail`, … | mapped through `mjuSubjectAdapter` |

**This is a contract mismatch, and it is the single most important finding of this workstream.** The MJU portal
protocol as evidenced by the sample is *not* OAuth 2.0: the parameter is `ac`, the token call carries no secret
and no `grant_type`, and the sample echoes nothing back for `state`.

### 2.2 RAE V2 currently refuses rather than guesses — which is correct

`ssoService.handleCallback` hard-blocks the portal path:

```
if (portalConfigReady(config.sso) && config.sso.provider !== 'mock') {
  throw new HttpError(503, 'SSO_NOT_READY', 'MJU callback query contract is not confirmed');
}
```

And `mjuSubjectAdapter` deliberately refuses to treat `ac` as an identity
(`treatQueryAcAsSubject` is a trap that throws if enabled). This matches `AGENTS.md`: *the MJU protocol and the
callback `ac` value are unconfirmed — do not assume OIDC.*

**Conclusion:** do **not** change the protocol on the strength of a sample file. The sample is strong evidence,
not confirmation. It belongs in the evidence pack that goes to MJU (§5).

### 2.3 Security controls that already exist (verified by reading, tests pass)

| Control | Status |
|---|---|
| CSRF/`state` single-use, TTL 10 min | `ssoStateStore` — `consume()` deletes on use |
| Subject guard (rejects email-shaped, `ac`-as-subject, >255, malformed) | `domain/identityLink.js`, shared by both link paths |
| Identity bound to `employee_uid`, never derived from SSO attributes | ADR-012 + `D-2026-10-21-04` |
| No automatic merge on ambiguity | `CONFLICT` / `QUARANTINE` |
| Access-token revocation on logout | `accessTokenRevocation` |

### 2.4 Gaps for live test

1. **`ac` vs `code`** — the callback reader must accept the MJU parameter once confirmed. Until then the portal
   path stays blocked. This is a **contract** gap, not a coding gap.
2. **`state` is not returned by the sample.** If MJU does not round-trip `state`, CSRF protection must be
   re-based on a server-set cookie bound to the browser session. Needs a vendor answer.
3. **No `client_secret`** in the sample. If MJU has none, `oauthConfigReady` must not be required for portal mode
   (it currently would be, via `requiredConfig`).
4. **Replay protection.** The sample has none. RAE V2 should record a used `ac` value with a short TTL so a
   replayed callback cannot mint a second session — needs the real TTL from MJU.

## 3. Signout / logout (C2) — implemented

Adapted from `sso/sampleSignout.aspx.vb`, with three deliberate divergences:

| Sample behaviour | RAE V2 | Why |
|---|---|---|
| `Session.RemoveAll()` | server revokes **access + refresh** tokens **before** any redirect | the session must be dead server-side first |
| Expire cookie with `Domain="mju.ac.th"` | **refused** (`SSO_COOKIE_DOMAIN_NOT_ALLOWED`) | a parent-domain cookie belongs to every MJU subdomain — deleting it destroys another app's state, and writing one would let any sibling subdomain read it |
| Expiry only | full attributes: `Path`, `Secure`, `HttpOnly`, `SameSite`, `hostOnly` | a deletion whose `Path` differs silently fails |
| `signout.aspx?cid=<sample ID>` | `signout.aspx?cid=<RAE ID>`, validated | wrong registration |
| No return-URL validation | `resolveAfterSignoutUrl` — exact-origin check | open redirect |

**Cookie reality:** RAE V2 authenticates with a bearer token in `localStorage` and sets **no auth cookie**, so
logout clears only its own three keys. **No `mju.ac.th` cookie is touched and no unrelated cookie is deleted.**

**New endpoint:** `GET /auth/sso/signout` — public, revokes nothing, redirects to the MJU signout page. It takes
no credential by design (a URL-borne credential would be a log-out-anyone primitive). Repeated logout and a
closed tab are therefore safe.

## 4. Mock QA (C3) — results

16 automated cases in `backend/tests/ssoSignout.test.js`, synthetic identities only, no network:

| Area | Cases |
|---|---|
| Client ID | sample ID refused (message does not echo it); RAE ID accepted, case-normalised; missing/malformed refused |
| Signout endpoint | must be https, absolute, credential-free, fragment-free |
| Signout URL | `cid` present exactly once; a stale `cid` replaced not appended; cannot be built from the sample ID |
| Open redirect | same-origin ok; path-only resolves on the single allowed origin; **9 rejection cases**; look-alike hosts (`raeservice.mju.ac.th.evil.example`, `evil-…`, other port, `http:`) all refused; relative path with 0 or 2+ origins is ambiguous |
| Fallback | configured fallback used and itself validated |
| Cookies | parent-domain refused; descriptor is host-only with all five attributes; illegal cookie names refused |

Plus the pre-existing SSO suites (callback wiring, identity chain, boot) — **44 tests pass** across
`ssoSignout`, `sso`, `ssoCallbackWiring`, `boot`; backend total **184 pass / 7 skipped / 0 fail**; frontend
`vue-tsc --noEmit` clean.

**Not tested locally, by design:** a real callback exchange, a real token response, a real signout round-trip.
Those are `SSO_LIVE_TEST_REQUIRED`.

## 5. Prerequisites before any live test

**Owner approval required.** Then:

1. **Owner/MJU confirmation of the contract** (§2.4): the `ac` parameter name, the token endpoint body, whether a
   client secret exists, whether `state` is round-tripped.
2. **VPS settings** (not applied — recorded only):
   `SSO_ENABLED=true`, `SSO_CALLBACK_CONFIRMED=true`, `SSO_PROVIDER=portal`, `SSO_CLIENT_ID=<RAE ID>`,
   `SSO_SIGNIN_URL`, `SSO_SIGNOUT_URL=https://sso.mju.ac.th/signout.aspx`,
   `SSO_AFTER_SIGNOUT_URL=https://raeservice.mju.ac.th/attendance-v2/`,
   `SSO_CALLBACK_URL=https://raeservice.mju.ac.th/api/v1/auth/sso/callback`, `APP_URL=https://raeservice.mju.ac.th`.
   **No client secret** unless MJU confirms one. Place in `.env` on the host; never commit.
3. **Callback reachability** from outside: `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` must be
   publicly reachable over `https` *before* the test, else the round-trip cannot complete.
4. **Diagnostic first:** run with `SSO_CALLBACK_DIAGNOSTIC=true` to capture the real query contract (it logs
   field names and lengths only, then refuses). **This is the cheapest way to settle §2.4** and it exposes no
   personal data.
5. **One synthetic account**, not a real employee, for the first round-trip.
6. **Rollback:** set `SSO_ENABLED=false` to disable instantly.

## 6. Unresolved risks

| # | Risk |
|---|---|
| R1 | The real MJU protocol may differ from the sample in ways the sample cannot show (error shapes, `ac` lifetime, replay window). |
| R2 | If `state` is not round-tripped, the existing CSRF defence cannot be used as-is; a cookie-bound binding would need review. |
| R3 | `employee_identifier.id_value` holds **raw** national IDs on `main` today (F9 unapproved), so a live callback that resolves by national ID would write plaintext. **SSO live testing should not proceed until F9 is approved**, or the adapter must be proven not to persist a national ID. |
| R4 | No replay ledger exists for `ac`; adding one is a schema change that needs its own approval. |
