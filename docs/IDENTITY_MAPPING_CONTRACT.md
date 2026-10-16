# Identity Mapping Architecture & Data Contract (restricted identity)

**Status:** `DESIGN — AWAITING OWNER APPROVAL`. **No migration executed, no real identity imported, no
production change.** This document proposes; it does not activate.
**Date:** 2026-10-16 · **Branch:** `feat/slice6-reconciliation`
**Companion:** [`IDENTITY_INTEGRATION_AUDIT.md`](IDENTITY_INTEGRATION_AUDIT.md) (the source audit) and
[`13_REFERENCE_PROJECT_AUDIT.md`](unified/13_REFERENCE_PROJECT_AUDIT.md).

> ### สรุปผู้บริหาร (Thai abstract)
>
> โครงสร้างเอกลักษณ์บุคคลที่ต้องการ **มีอยู่แล้วเกือบทั้งหมด** ใน V2 (HMAC + key version, AES-GCM ปิดไว้โดยค่าเริ่มต้น,
> สถานะ `candidate`/`approved`, การห้าม auto-approve ตามนโยบาย S9) สิ่งที่ **ยังขาด** คือ **สัญญาการนำเข้าจาก
> MJU Person API** และ **การกำหนดอายุการใช้งาน (effective dating) ของลิงก์ตัวตน** เอกสารนี้กำหนดสัญญานั้น
> และ **ยังไม่ดำเนินการอะไรทั้งสิ้น** — เป็นการออกแบบเพื่อขออนุมัติ
>
> **ข้อห้ามที่ต้องยึด:** ห้ามเชื่อมโยงด้วยชื่อ อีเมล หรือเลขบัตร 6 หลักท้าย · ห้าม auto-approve ·
> ห้ามใช้เลขบัตรประชาชนเป็น primary key · SSO ต้องไม่อนุมัติตัวตนโดยอัตโนมัติ

---

## 1. The canonical chain

```
            (restricted evidence)                          (canonical, immutable)            (effective-dated)
  citizenID ──HMAC-SHA-256(key_version)──▶ lookup_hmac ──▶    employee_uid    ──▶ ┌─ facescan_id   (attendance)
             keyed lookup only, never plaintext                                    ├─ personnel_id  (MJU kind)
                                                                                   └─ verified SSO subject
                                                                                       (identity_links)
```

| Element | Role | Storage | Never |
|---|---|---|---|
| `citizenID` (Thai national ID) | **Evidence only.** The protected join key that proves two records are the same person. | **Never plaintext.** Either discarded, or AES-256-GCM ciphertext behind a necessity approval. | used as a primary key, an attendance key, a URL, a log field, or a display value |
| `employee_uid` | The **only** canonical identity. Immutable UUID. | plain | reused, reused for a different person, or derived from an identifier |
| `facescan_id` | HIP attendance reference | `employee_identifier`, effective-dated | reused across employees |
| `personnel_id` | MJU reference (`source_system='mju_person_api'`) | `employee_identifier`, effective-dated | invented for a contractor |
| verified SSO subject | Session authority | `employee_identity_links`, status-gated | treated as approval of the employee link |

**Rule (Blueprint §8):** *"Do not merge employee codes or use national ID as permanent join key."* The
national ID identifies a **person**; it never identifies an attendance record.

## 2. What already exists (VERIFIED today, with file evidence)

This is not a greenfield design. The following are implemented and tested:

| Capability | Evidence |
|---|---|
| Keyed, versioned HMAC lookup; canonicalisation; Thai-digit + checksum handling; masking | `backend/src/security/nationalIdContract.js` — `canonicalizeNationalId`, `isValidNationalIdChecksum`, `maskNationalId`, `buildLookup`, `identifierLookupHmac` |
| AES-256-GCM raw storage **disabled by default**, requires a necessity approval ref, key independent of the HMAC key | same file, `encryptRawIdentifier` (`RAW_STORAGE_DISABLED`, `NECESSITY_APPROVAL_REQUIRED`) |
| Key rotation (current + previous), version validation, key-reuse rejection, write freeze during rotation | `loadIdentifierKeys`, `EMPLOYEE_IDENTIFIER_NATIONAL_WRITE_FREEZE` |
| Cross-key-version duplicate detection and reindex **planning** (pure) | `detectCrossVersionDuplicates`, `planReindex` |
| Audit rows that **reject** PII (a run of 10+ digits is refused) | `buildAuditEvent` → `AUDIT_TEXT_REJECTED` |
| Identifier uniqueness `UNIQUE(id_type, id_value)` + namespace collision guard (same text in `facescan_id` and `personnel_id` on two employees) | migration `017_identifier_namespace_claim.sql` + triggers; `docs/IDENTITY_KIND_MAPPING.md` |
| Effective-dated identifiers / assignments | migration `020`; `backend/src/domain/identifierValidity.js` (`isEffectiveOnDate`, `normalizeValidityWindow`) |
| Link status model, **only `approved` is authenticatable** | `backend/src/domain/identityLink.js` `LINK_STATUS`, `isAuthenticatableStatus` |
| **Enrichment results can be blocked from approval** — `mju_person_enrich` is already a known source, and `ambiguous`/`not_found`/`timeout`/`api_error`/`fallback`/`firstname_only` all block | `identityLink.js` `ENRICHMENT_SOURCES`, `BLOCKED_ENRICHMENT_OUTCOMES`, `enrichmentBlocksApproval`; enforced at `identityResolutionService.js:125` → `403 IDENTITY_REVIEW_REQUIRED` |
| Candidate links are **never promoted automatically** (Policy S9) | `identityResolutionService.js:36,227` → `403 IDENTITY_NOT_APPROVED`; `ssoIdentityRuntime.test.js` (`S9:`), `ssoIdentityChain.test.js`, and `docs/unified/03_SECURITY_INCIDENT_REGISTER.md:147-151` |
| No email/name linking at the SSO boundary | `backend/src/services/sso/mjuSubjectAdapter.js` `EMAIL_LIKE` → `email_only_rejected` (lines 54, 67, 98) |

**Consequence:** the design below is mostly *contract and governance*, plus two genuine additions: the
**Person-API ingestion path** and **effective dating on identity links**.

## 3. The MJU Person API ingestion contract (the new work)

Source audit: [`IDENTITY_INTEGRATION_AUDIT.md`](IDENTITY_INTEGRATION_AUDIT.md). The only observed contract is
`GET https://apis.mju.ac.th/person/v1/filter/{firstName}/{lastName}` with `Authorization: Bearer <token>`,
returning a **top-level JSON array** of 46-field person records (verified against a 308-record on-disk cache).

**The field reality matters and differs from the operator documentation** (see the audit §1):

| Field | Reality |
|---|---|
| `citizenID` | **present** (308/308, 13 chars). Not checksum-validated, not uniqueness-checked. |
| `personnelID` | **ABSENT — 0/308.** The API returns no personnel id at all. |
| `email` | **ABSENT.** The API field is `e_mail`; the code reads `email`, so every output e-mail is empty. |
| `personTypeName` | **ABSENT.** Not in the response at all. |
| `faculty`, `position` | present (308/308) but **not read** by the live script. |
| `nationId` | present (308/308) — a **second** national-ID-like field, never compared with `citizenID`. |

> **This breaks the obvious plan.** V2's MJU kind wants `personnel_id` with `source_system='mju_person_api'`,
> but this API **does not return one**. So the Person API cannot supply the MJU primary reference at all — it
> can only contribute **`citizenID` equality** as corroboration. Whether a `personnelID` endpoint exists is an
> open question (audit §8.2).

> **Second correction:** the `/filter/` endpoint is **fuzzy, not exact** — 7 of 308 returned records carry a
> name that differs from the name queried (audit §2). A fuzzy name match is therefore not even reliable
> *corroboration* on its own; it is a lead, not evidence.

> **That endpoint's search key is a NAME.** Everything below is designed so that a name search can never
> itself become a link.

### 3.1 Ingest rules (all mandatory)

| # | Rule | Why |
|---|---|---|
| I1 | **The Person API is a CANDIDATE SOURCE, never an authority.** It may only produce `candidate` identities requiring human approval. | Its lookup key is a name; a name is not identity evidence. |
| I2 | **The join key is the protected national ID, not the name.** A Person-API record may be attached only after its `citizenID` is canonicalised and resolved through `buildLookup('national_id', …)` to an existing `employee_uid`. | Gives a cryptographic join instead of a textual one. |
| I3 | **A record whose `citizenID` is absent, uncanonicalisable, or fails the checksum is discarded** (counted, never guessed). `status` must be exactly `found`. | The audit shows the field can legitimately be absent, and no script validates its shape before use. |
| I4 | **Every non-`found` outcome is a blocked outcome.** If the API returns more than one match, the record is `ambiguous` and **must not be resolved to the first element**. | All four scripts currently take `data[0]`; that is precisely what must not be inherited. |
| I4b | **A `citizenID` observed under two different name queries is a hard conflict** and must be quarantined for human review. | The audit found exactly this in the existing cache (two ids spanning two people), which would violate `UNIQUE(id_type, id_value)`. |
| I4c | **`nationId` must not be treated as `citizenID`**, and must not mint a link. | It is a second, uncompared identifier-like field; whether it is the same system is unknown. |
| I5 | **A name match is never sufficient, and a fuzzy match is not reliable.** Name agreement may be recorded as a weak corroboration; it must not create, approve, or promote a link. The `/filter/` response must be re-checked against the queried name before it is believed. | Policy S9, plus audit §2 (fuzzy endpoint, 7/308 mismatched names). |
| I6 | **Provenance is mandatory:** `source='mju_person_enrich'`, `enrichmentOutcome`, the API request identifier, the response count, and the approving operator. | An approval must name its evidence. |
| I7 | **No email-shaped or `ac`-shaped subject** may be introduced by this path. The ingestion must apply the same `EMAIL_LIKE` and `ac` guards the SSO adapter applies. | Defence in depth: `createCandidate` alone does **not** guard these (§4, finding F1). |
| I8 | **Idempotent and non-destructive.** Re-running may update `candidate` evidence; it must never mutate an `approved` link or an identifier without a new explicit approval. | The audit found the existing tool appends on re-run and silently skips already-present rows, so it is neither. |
| I9 | **The ingestion must not adopt the tool's CSV conventions.** In particular the `citizen_id` value is written as the formula `` ="<id>" `` (audit §2b); anything V2 produces must keep a value inert, as the R-03 export layer does with `inlineStr`. | A formula in a spreadsheet is executable content, and a 13-digit value is exactly the thing Excel mangles. |

### 3.2 The ingestion shape (proposed, not implemented)

Because the API returns **no `personnelID`**, it cannot supply a provider subject. The only sound shape is:
resolve the employee **first** (from V2's own protected data), then attach the Person-API observation as
**corroboration evidence** — never as the thing that decides who someone is.

```js
// Candidate-only corroboration. No identifier rows are written, no subject is minted from a name.
ingestPersonEnrichEvidence({
  employeeUid,            // ALREADY resolved by HMAC national-ID lookup inside V2, before this is called
  providerKey: 'mju_sso',
  // No providerSubject is taken from the Person API: the response carries no stable key. If a subject is
  // later minted it must come from a VERIFIED SSO subject, not from this endpoint.
  subjectType: 'candidate:person_api_corroboration',
  evidence: {
    source: 'mju_person_enrich',
    enrichmentOutcome: 'found' | 'ambiguous' | 'not_found' | 'timeout' | 'api_error',
    matchCount, citizenIdPresent: true, citizenIdChecksumValid: true,
    citizenIdDigestMatches: true,   // equality against V2's own HMAC digest — the actual corroboration
    nameCorroborated: true,         // recorded, NEVER decisive
    nationIdPresent: true,          // recorded, NOT treated as citizenID
    requestRef, respondedAt,
  },
})
// -> creates or updates a `candidate` link only. Approval is a separate, human, audited call.
```

Any `enrichmentOutcome` other than `found` is already blocked from approval by `enrichmentBlocksApproval`,
so the guard exists — the new work is the **caller** discipline.

**If no corroboration is possible** (no stable key, no digest equality), then nothing is ingested at all, and
MJU-kind population stays blocked pending an API that returns a stable identifier (audit §8.2).

## 4. Policy invariants and their verification

Verified today by an independent probe driving the real services (31 assertions, **0 failures**):

| Requirement | Invariant | Result |
|---|---|---|
| B.2 | `maskNationalId` exposes only `****NNNN`; a masked value is **not** canonicalisable, fails the checksum, and `buildLookup` rejects it as `INVALID_IDENTIFIER` | **PASS** |
| B.2 | The lookup digest is 64-hex, never equals the plaintext, differs per key version, and is labelled with its version | **PASS** |
| B.2 | A masked value can never be used as a lookup key. **Repo-wide check:** the only `slice(-4)` occurrences are masking helpers for display — `nationalIdContract.js` `maskNationalId` and the same code retained in `docs/patches/main-workspace-idcard-shared-contract.patch`. No code path compares, matches or keys on a masked or shortened identifier. | **PASS** |
| B.3 | An enrichment link is created as `candidate`, records its `source` and `enrichmentOutcome`, and has an empty `approvedBy` | **PASS** |
| B.3 | Approval requires an explicit `approvedBy` (`400` otherwise) and records who approved it | **PASS** |
| B.3 | **All six** blocked enrichment outcomes cannot be approved (`403 IDENTITY_REVIEW_REQUIRED`) | **PASS** |
| B.3 | `ambiguous` / `low` confidence from an enrichment source also blocks approval | **PASS** |
| B.3, B.5 | The same provider subject cannot link twice (`409 IDENTITY_DUPLICATE`); an employee cannot hold two approved links for one provider (`409 IDENTITY_CONFLICT`) | **PASS** |
| B.6 | A `candidate` cannot resolve (`403 IDENTITY_NOT_APPROVED`); only an `approved` link resolves | **PASS** |
| B.6 | The SSO adapter refuses email-shaped subjects and email-only profiles (`email_only_rejected`) and never verifies `ac` as a subject | **PASS** |
| B.5 | No code path matches on last-4/6 national-ID digits; there is no name-based lookup API | **PASS** |

### Finding F1 — defence-in-depth gap (not a vulnerability)

`identityResolutionService.createCandidate` applies **no email-shaped guard of its own**; it accepted
`someone@example.test` as a `candidate`. It is safe today because:

1. the SSO adapter rejects such subjects first (`EMAIL_LIKE`), and
2. a candidate is never authenticatable without a human approval.

**But** any *future* non-SSO caller — including the §3 ingestion path — must apply the guard itself.
**Recommended:** add the `EMAIL_LIKE` + `ac` guard inside `createCandidate` so the rule is enforced at the
layer that owns the link, not only at one entry point. Recorded, not fixed here.

> **RESOLVED 2026-10-16 (hardening ID-6).** The guard now lives once, in the domain module
> (`backend/src/domain/identityLink.js`, `rejectionCodeForProviderSubject`), and is called by **both**
> `createCandidate` and `linkProviderSubjectFromSsoLogin`. The SSO adapter imports the shared predicates
> instead of keeping private copies, so the two can no longer drift. It additionally rejects what the
> original review did not test: non-string/array/object subjects, non-finite numbers, subjects over 255
> characters, and whitespace-padded forms of `ac` and of e-mail addresses. The rejected value is never
> echoed into the error message. Priorities are now explicit and distinct rather than one generic 400:
> `IDENTITY_SUBJECT_IS_EMAIL_LIKE`, `IDENTITY_SUBJECT_IS_CALLBACK_AC`, `IDENTITY_SUBJECT_MALFORMED`,
> `IDENTITY_SUBJECT_TOO_LONG`. Mutation-tested — removing the guard fails **5** tests.

### Finding F2 — the enrichment guard is scoped to enrichment sources

`enrichmentBlocksApproval` returns `false` for a non-enrichment source (e.g. `operator_review`) even when the
outcome is `ambiguous`. That is **intended** (an operator review is human evidence), but it means the
"ambiguous never approves" rule is a property of the *source*, not of the outcome. Any new automated source
must be added to `ENRICHMENT_SOURCES`, or it will bypass the guard. **Recommended:** make the source list a
checked constant and add a test that every automated source is listed.

> **RESOLVED 2026-10-16 (hardening ID-7).** The gap was worse than "a source might be forgotten": because the
> guard is source-scoped, a caller could pass an **invented** source string and create a link whose
> `ambiguous` outcome would then sail past approval. The source list is now a **frozen allowlist**
> (`IDENTITY_LINK_SOURCES`) and an unknown source is **refused at creation** on both paths
> (`400 IDENTITY_SOURCE_UNKNOWN`), so provenance can no longer be asserted into existence.
>
> Two guard properties are pinned deliberately, and they are asymmetric on purpose:
> * **creation is strict** — `isKnownSource` requires an EXACT match. A `source` comes from our own code, so a
>   stray space is a bug to surface, not to normalise. Strict equality also guarantees the value *stored* is
>   always a value that was *validated*.
> * **the approval guard is lenient** — `isEnrichmentSource` trims, so a legacy row written as
>   `'mju_person_enrich '` is still treated as machine evidence and still cannot be approved.
>
> A test (`identityLinkSourcePolicy.test.js`) fails if a source literal appears in a link-creating code path
> without being added to the allowlist, and fails if an allowlist entry becomes dead — so the list cannot rot
> in either direction. `person_api_enrich` is allowlisted but declared unused-by-design, with the reason.
>
> **Honest boundary, asserted rather than assumed:** `enrichmentBlocksApproval` still returns `false` for a row
> that predates the allowlist and was written directly to the store. The control against that is create-time
> rejection, and the test file states this explicitly instead of implying the guard covers it.

### 4.1 Post-hardening verification (2026-10-16, ID-6/ID-7)

| Gate | Result |
|---|---|
| `npm run lint` | **PASS** |
| Full backend suite | **PASS — 508 tests, 498 pass, 0 fail, 10 skipped** (was 476/466/0/10) |
| New suites | **PASS — 26 + 6 = 32 tests** (`identityLinkHardening`, `identityLinkSourcePolicy`) |
| `contract-smoke` | **PASS — 36 paths** |
| Secret scan | **PASS — 388 files** |
| Frontend build | **PASS** |
| National-ID fixture guard | **PASS** (no checksum-valid literal; the new tests use no national ID at all) |
| **Mutation: subject guard removed** | **KILLED — 5 tests fail** |
| **Mutation: source allowlist removed** | **KILLED — 4 tests fail** |
| **Mutation: declared-evidence check removed** | **KILLED — 1 test fails** |

The mutation column is the one that matters: a guard whose removal changes nothing is decoration. It also
caught a real weakness while being written — the source-policy scan initially matched **0** literals and
reported success, because the sources reach the link as a ternary and as a default parameter rather than as
`source: 'literal'`. The non-vacuity assertion is what exposed it.

`person_api_enrich` is allowlisted but **declared unused by design** (the Person-API ingestion path is behind
the open design gate). The policy test fails if an allowlist entry becomes dead without such a declaration,
and fails if a declared-unused entry becomes used, so the list cannot rot in either direction.

## 5. Effective-dating of identity
`employee_identifier` is already effective-dated (migration `020`, `identifierValidity.js`). What is **not**
yet effective-dated is the **identity link** itself.

**Proposal (design only):**

* Add `effective_from` / `effective_to` (nullable DATE, `NULL` = unbounded) to `employee_identity_links`,
  matching the `employee_identifier` convention exactly (two nullable DATE columns, inclusive bounds,
  `onDate = null` meaning "do not filter").
* A link is usable only when `status='approved'` **and** it is effective on the session date.
* History is preserved: a re-link closes the previous window rather than deleting it, so a past session can
  be explained.
* `personnel_id` / `facescan_id` re-use cannot silently move a person: `UNIQUE(id_type, id_value)` plus the
  017 namespace triggers already forbid the same value on two employees.

## 6. Authorization, privacy and operations

| Control | Requirement |
|---|---|
| **RBAC** | Linking and approving are **HR/administrator** operations. An ordinary session can never approve its own link, and an SSO login never grants HR. |
| **Row-level access** | An employee may read only their own identity state; they may never read another employee's identifiers, and never a raw `citizenID` (which no API returns at all). |
| **Public surface** | No endpoint may return a `citizenID`, an HMAC digest, a key version, or a raw identifier. Reads return the kind (`MJU`/`HIP`) and at most a masked form. |
| **Audit** | Every lookup, create, decrypt, reindex and approval writes an `audit_events` row: actor, action, target, outcome, correlation id — **metadata only**, and `buildAuditEvent` rejects anything that looks like PII. |
| **Crypto / KMS** | HMAC and encryption keys come from the environment or a `*_FILE` secret mount, never the repo. Rotation uses current + previous with a version; the write-freeze flag blocks `national_id` writes during a rotation window. |
| **Data minimisation** | The HMAC digest is sufficient to prove sameness. Raw `citizenID` storage stays **disabled** (`EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED=false`) unless a necessity approval names a lawful basis. |
| **No logs** | No raw identifier in logs, error messages, URLs, screenshots, fixtures, PR text or Agent Core prompts. Existing `HttpError` messages carry a code, not a value. |

### 6.1 MJU API governance obligations (evidence found on this machine)

A **separate**, previously uncited document set exists at `G:\AI\docs\integrations\` (8 files, dated
2026-05-20). They are **recommendation / plan** documents for a *different* consumer (a RAE Next.js app), **not**
the MJU Person API's OpenAPI spec — so they do **not** answer whether a stable `personnelID` endpoint exists.
Two of them are nonetheless directly binding on this design, and were found only while confirming that the
referenced `MJU_PERSON_ENRICHMENT_KB.md` is missing:

| Source | Requirement | Consequence for this contract |
|---|---|---|
| `MJU_API_GOVERNANCE_POLICY.md` | *"All requests for personal/sensitive data require **DPIA and privacy officer sign-off**"*; *"multi-stakeholder approval required for sensitive endpoints (**Admin + Data Owner + Privacy Officer**)"* | **This is the concrete approval path for G7**, and it means the gate is not merely "owner approves" — a DPIA is a prerequisite, not a formality. |
| same | *"Data minimization: only expose necessary fields; **minimize PII in responses**"*; *"restrict export of PII"*; *"redact or hash direct identifiers in logs"* | Confirms §6 (row-level access, no PII in logs) and §3 (the HMAC digest is sufficient; raw storage stays off). |
| same | RBAC roles for API access are **Requestor / Developer / Admin / DataOwner / Security / Operations**, with **MFA required for Admin and DataOwner** | These are **platform-access** roles, distinct from V2's employee roles. V2 is a *client*: it needs a registered `api_clients` entry, an owner, and DataOwner/Privacy-Officer approval — not an employee role. |
| same | *"tokens stored and rotated in Secret Manager; no plaintext in repo or emails"*; quarterly access reviews; annual compliance audits | Aligns with §6 crypto/KMS; adds a **quarterly review** and **annual audit** obligation to the operational side. |
| same | *"Each API endpoint must have an assigned owner… defining sensitivity"*; *"Maintain OpenAPI spec per version"* | The Person API endpoint should have a documented **owner + sensitivity classification + OpenAPI spec**. Requesting those is a concrete, cheap evidence step before integration. |
| `MJU_API_INTEGRATION_PLAN.md` | All MJU API calls must be **server-side** through an adapter; credentials only from env (`MJU_API_BASE_URL`, `MJU_API_TOKEN`); **no credential in source**; `Cache-Control: no-store` when the payload is personal data | Already how R-03 treats personal data (`no-store, private`), and consistent with keeping enrichment off any client and off the SSO callback path. |

`MJU_API_DB_SCHEMA.md` is explicitly a **"recommended"** platform schema (requests / clients / token metadata /
audit logs / endpoint catalog / access policies / rate limits). It does **not** describe the person API's field
list, so **ID-5 (`personnelID`) remains open**. It does usefully confirm the shape V2 should mirror for audit and
token metadata (`scope`, `rotation_version`, `last_rotation`, `revoked_at`, append-only audit).

**Not authority:** these are summaries and proposals, and their presence does **not** substitute for a DPIA, a
privacy-officer sign-off, or the endpoint's own OpenAPI spec. They sharpen *what to request*; they do not lower
the gate.

## 7. Fail-closed matrix (what must deny)

| Situation | Required outcome |
|---|---|
| `citizenID` missing / uncanonicalisable / checksum fails | **discard**, count, no link |
| Person-API returns >1 match | `ambiguous` → **no link, no approval** |
| A name matches but no protected-ID match | **no link** |
| Link is `candidate` / `rejected` / `revoked` | **no session** (`403 IDENTITY_NOT_APPROVED`) |
| Two employees claim one name | **both stay separate**; never merged |
| Same identifier text in two namespaces on two employees | **`409 IDENTIFIER_NAMESPACE_COLLISION`** |
| Key missing / not configured | **`NOT_CONFIGURED`**, no plaintext fallback |
| Raw storage requested without a necessity ref | **`NECESSITY_APPROVAL_REQUIRED`** |
| Writes during a key-rotation freeze | **`NATIONAL_ID_WRITES_FROZEN`** |

## 8. Migration proposal (NOT executed — needs `ARCHITECTURE_APPROVED`)

Proposed only. Nothing was applied, and the live ledger is pre-`013` so no apply order exists yet.

| # | Change | Notes |
|---|---|---|
| M1 | `employee_identity_links`: add `effective_from`, `effective_to` (nullable DATE) + an index | Mirrors the `employee_identifier` window convention; no data rewrite |
| M2 | `employee_identity_links`: add `enrichment_outcome`, `evidence_ref` if not already present | Provenance for an approval |
| M3 | `employee_identifier`: add `source_system` if not already enforced for `personnel_id` | Already required by the service (`PERSONNEL_ID_SOURCE_REQUIRED`) |
| M4 | `identifier_lookup_audit` / `audit_events`: confirm the metadata-only shape and an index on `(employee_uid, action, created_at)` | Audit retrieval without exposing values |
| M5 | **No** change to `015`/`017`; **do not rename** any applied migration (the ledger keys on the filename with no checksum) | Standing rule |

Sequencing constraints: `#30 → #33 → #34/#35` for the lower stack; migration numbering must avoid the claimed
`018`/`019` and the duplicated `013`/`015` prefixes. **No real identity import** accompanies any of this.

## 9. Open items and the design gate

| # | Item | Owner decision needed |
|---|---|---|
| G1 | ~~**F1** — enforce the email-shaped / `ac` guard inside `createCandidate`~~ | **DONE 2026-10-16 (ID-6)** — enforced in the domain layer, shared by both creation paths, mutation-tested |
| G2 | ~~**F2** — make `ENRICHMENT_SOURCES` a checked, tested constant~~ | **DONE 2026-10-16 (ID-7)** — frozen allowlist; unknown sources refused at creation; drift guarded by a test in both directions |
| G1b | **Residual, still open:** record the approval EVIDENCE TYPE on the link row instead of only `approvedBy: 'system:sso'`. The SSO path now requires a *declared* matched national-ID lookup (`403 IDENTITY_EVIDENCE_REQUIRED`), but the declaration is not independently verifiable in the link layer and is not stored as its own field. | needs a column → **migration + owner approval** (S-02) |
| G3 | Effective dating on `employee_identity_links` (§5) | approve the model |
| G4 | Whether any raw `citizenID` storage is ever lawful, and the necessity basis | owner + data protection |
| G5 | The Person-API ingestion path (§3) — build it, or keep enrichment manual? | approve scope |
| G6 | Whether MJU will certify a **stable, unique subject** (today `humanID` is candidate-only) | MJU IT |
| G7 | **DPIA + privacy-officer sign-off, and multi-stakeholder approval (Admin + Data Owner + Privacy Officer)** for personal/sensitive data access. The *requirement* is documented in `MJU_API_GOVERNANCE_POLICY.md`; **no evidence of a completed DPIA was found.** | owner + privacy officer |
| G8 | The Person API endpoint's **assigned owner, sensitivity classification and OpenAPI spec** — the governance policy requires all three to exist per endpoint | MJU IT / endpoint owner |
| G9 | A registered **`api_clients` entry** with an owner and approved scopes for V2, plus token rotation in Secret Manager and the quarterly access review | owner + platform admin |

> ### 🛑 STOP — design/review gate
>
> Real identity integration is **not activated**. No live ID-card processing, no import of real identities, no
> migration executed, no key created or rotated, no production change. Activation requires explicit owner
> approval of §8 and §9, a completed **DPIA plus privacy-officer sign-off** (§6.1, **G7**), and the endpoint's
> own documented owner/sensitivity/OpenAPI spec (**G8**).
