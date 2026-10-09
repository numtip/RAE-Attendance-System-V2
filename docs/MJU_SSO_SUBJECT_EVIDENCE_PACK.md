# MJU SSO subject contract — evidence pack

**Status:** Documentation only. **SSO subject contract: UNKNOWN.** **SSO runtime: DISABLED.** HTTP callback is **not** wired to the identity chain.

**Related:** [Admin request](./MJU_SSO_ADMIN_REQUEST.md) · [Response template](./MJU_SSO_SUBJECT_CONTRACT_RESPONSE_TEMPLATE.md) · [Integration checklist](./SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md)

Sources are limited to V2 repo docs, public MJU registration values, and read-only public page observations recorded in `SSO_READINESS.md` and `SSO_CONTRACT_CONFIRMATION.md`. No live sign-in was completed for this pack. No new protocol facts were invented here.

---

## A. Executive summary

**Confirmed:** MJU registered an SSO client for RAE Attendance System V2 with a fixed callback URL, portal sign-in/sign-out URLs using `cid`, and an observed callback transport of `GET` with a single query field `ac` (32 characters, no body). V2 keeps `SSO_ENABLED=false`, `SSO_SUBJECT_CONTRACT_CONFIRMED=false`, and rejects using `ac` or email alone as the permanent SSO identity. Approved links in `employee_identity_links` are the intended gate after a verified subject exists.

**Unknown:** The meaning of `ac`, how it is validated or exchanged, whether token/userinfo endpoints exist, client secret requirement, callback signing, and the authoritative immutable user subject field. Without those facts, V2 cannot safely map a callback to an employee.

**Why fail-closed:** Issuing a session from an unconfirmed callback would guess identity, risk wrong account linkage, and bypass the human-approved identity-link model. V2 denies until MJU supplies a written contract and operators record answers in the response template.

---

## B. Confirmed evidence table

| Item | Status | Evidence | Security implication |
|---|---|---|---|
| MJU V2 client registration | **CONFIRMED** | Client name and public client id documented in `SSO_READINESS.md` (registration value, not a secret) | Use only the registered client id in sign-in/sign-out `cid`; do not reuse legacy client ids |
| Client id (public) | **CONFIRMED** | Same registration table in `SSO_READINESS.md` | Safe to cite in admin mail; never treat as authentication proof |
| Callback URL | **CONFIRMED** | `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` in registration docs | Route exists; must not issue sessions until subject contract is confirmed |
| Sign-in URL pattern | **CONFIRMED** | `https://sso.mju.ac.th/signin.aspx?cid=<client id>` | Redirect uses `cid` only; not an OAuth authorize URL by itself |
| Sign-out URL pattern | **CONFIRMED** | `https://sso.mju.ac.th/signout.aspx?cid=<client id>`; unauthenticated sign-out observed redirecting to registered after-signout URL | V2 may expose sign-out URL; does not prove callback identity |
| Callback HTTP method | **CONFIRMED** | `GET` documented in `SSO_READINESS.md` | Handler must not assume POST body for identity |
| Callback query field `ac` | **CONFIRMED** (shape only) | Single query parameter `ac`, length 32, documented in repo | **`ac` is not accepted as identity** in V2 adapter code and policy |
| Callback body | **CONFIRMED** | No body on callback observation in docs | Do not read identity from body until MJU documents otherwise |
| SSO runtime disabled | **CONFIRMED** | Default `SSO_ENABLED=false` in `.env.example` and config | Production and CI must not enable live MJU SSO without checklist |
| Subject contract gate off | **CONFIRMED** | Default `SSO_SUBJECT_CONTRACT_CONFIRMED=false` | `extractVerifiedSubject()` returns `unknown`; no chain session |
| Identity-link gate | **CONFIRMED** (design) | Migration `012_identity_links.sql`, `IdentityResolutionService`, approval workflow in `IDENTITY_LINK_MODEL.md` | Sign-in requires **approved** link + active employee; candidates cannot authenticate |
| HTTP callback ↔ identity chain | **CONFIRMED** (not connected) | `ssoCallbackWiring.test.js`, comment on `ssoService.handleCallback` | Callback must not bypass adapter until contract is written |
| Token endpoint | **UNKNOWN** | Not in registration; not on public sign-in page per contract matrix | Do not call guessed URLs |
| Userinfo endpoint | **UNKNOWN** | Same as token endpoint | Do not call guessed URLs |
| Client secret / API key | **NO EVIDENCE** | Empty in git; no field on public sign-in form | Do not invent secrets |
| Authoritative subject field | **UNKNOWN** | MJU has not documented immutable claim | Do not map `ac`, email, or username until confirmed |

---

## C. Unknown contract items

These nine items match `SSO_SUBJECT_CONTRACT_INTEGRATION_CHECKLIST.md`. All remain **UNKNOWN** (or **NO EVIDENCE** for client secret) until MJU responds.

| # | Item | Status |
|---|---|---|
| 1 | Authoritative subject field name | **UNKNOWN** |
| 2 | Subject stability / immutability | **UNKNOWN** |
| 3 | Where subject appears after callback `ac` | **UNKNOWN** |
| 4 | How `ac` is validated or resolved | **UNKNOWN** |
| 5 | Token / ticket exchange endpoint | **UNKNOWN** |
| 6 | Userinfo endpoint | **UNKNOWN** |
| 7 | Client secret requirement | **NO EVIDENCE** |
| 8 | Signature / hash verification on callback or token | **UNKNOWN** |
| 9 | Subject vs email relationship | **UNKNOWN** |

---

## D. Sanitized observed callback example

Shape only. **No real `ac` value. No cookies. No PII.**

```http
GET /api/v1/auth/sso/callback?ac=<32-char-opaque> HTTP/1.1
Host: raeservice.mju.ac.th
```

V2 diagnostic mode (when explicitly enabled) may log **parameter names and lengths only**, not values.

---

## E. V2 security boundary

Intended chain (prepared in code for tests; **not** connected to live HTTP callback):

```text
MJU SSO
  → verified subject (extractVerifiedSubject)
  → approved identity link (IdentityResolutionService.resolve)
  → active employee
  → RBAC / data scope (authorizationService on each API call)
  → V2 session (JWT + refresh)
```

Explicit denials:

| Rule | Rationale |
|---|---|
| **`ac` ≠ identity** | Observed query field is not proven to be an immutable user id |
| **Email-only ≠ permanent subject** | Directory email is not the SSO key; snapshots are audit evidence only |
| **Person API / `mju-person-enrich` ≠ runtime authenticator** | Local enrichment is operator review only; never on callback path |
| **Unknown contract ⇒ deny** | No session/JWT until subject is verified and link is approved |
| **Candidate / revoked links ⇒ deny** | Human approval required before authentication |

---

## Next step

Send [`MJU_SSO_ADMIN_REQUEST.md`](./MJU_SSO_ADMIN_REQUEST.md) to the MJU SSO administrator. Record verified answers in [`MJU_SSO_SUBJECT_CONTRACT_RESPONSE_TEMPLATE.md`](./MJU_SSO_SUBJECT_CONTRACT_RESPONSE_TEMPLATE.md), then update the integration checklist before any callback wiring.
