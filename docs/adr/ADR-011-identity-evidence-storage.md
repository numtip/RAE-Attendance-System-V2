# ADR-011 — Durable, verifiable identity evidence and approval provenance

**Status:** `PROPOSED - NOT APPROVED`
**Date:** 2026-10-16 · **Deciders:** repo owner (data owner), with privacy officer/DBA input for the deferred
items · **Workstream:** ID-6b / S-02 · **Supersedes:** nothing · **Superseded by:** nothing
**Revised 2026-10-16:** now also carries the **ID-7b** durable fix (`enrichment_outcome`) — the shipped
fail-closed guard is the stop-gap this migration relaxes (model §5.3).

> ### Numbering — why this is ADR-011 and not ADR-005
>
> The ID-6b track was initially instructed to use `ADR-005`, but the Phase-0 register
> [`../unified/04_ADR_DECISIONS.md`](../unified/04_ADR_DECISIONS.md) already assigns **ADR-005** to
> *"HIP attendance is independent of SSO"*. The collision was flagged by the track rather than silently
> created, and the register (which runs to `ADR-010`) was not edited by it.
>
> **Resolved 2026-10-16:** this ADR is renumbered **ADR-011**, the next free number, and every reference to
> it was updated. Nothing else changed. The register itself is a pre-existing untracked document owned by
> another session, so it was deliberately left untouched — adding the ADR-011 row to it is a separate,
> one-line change for whoever owns that file.

**Scope of this ADR:** how an approved identity link records **what evidence** justified it, durably and in a
way that can be re-checked later — without trusting a boolean that the approving caller asserted.

---

## 1. Context

### 1.1 The decision this replaces

The SSO first-login path inserts an **APPROVED** link while requiring the caller to *declare*
`evidence: { nationalIdLookupMatched: true }` (**VERIFIED** — `identityResolutionService.js:295-301`,
insert at `:329-340`; caller at `ssoIdentityResolutionService.js:162-165`). The declaration is:

* **not stored** — there is no column for it and no evidence table;
* **not independently checkable** — the HMAC lookup happens in `employeeIdentity.resolve('national_id', …)`,
  a different layer that holds the raw identifier; the link layer cannot repeat it;
* **therefore a contract check, not a proof** — the code says so itself
  (`identityResolutionService.js:288-294`: *"this assertion is NOT independently verifiable here … the durable
  fix is a dedicated evidence column on `employee_identity_links`, which needs a migration and is still open
  (S-02)"*).

Consequently the only durable traces of an approval are `approved_by = 'system:sso'`, `source =
'sso_national_id_resolution'` and a `sso_provider_link` audit event — none of which can tell a reviewer
**which national-ID binding** was matched. This is open item **G1b** in
[`../IDENTITY_MAPPING_CONTRACT.md`](../IDENTITY_MAPPING_CONTRACT.md) and **ID-6b** in
[`../memory/NEXT_ACTIONS.md`](../memory/NEXT_ACTIONS.md).

### 1.2 Constraints that shape the decision

| Constraint | Source |
|---|---|
| Raw national-ID storage is **disabled by default**; the keyed digest + key version is the existing pattern | ADR-004; `nationalIdContract.js`; migration `015` |
| A bit-identical proof must not put PII anywhere (repo is **public**) | ADR-010; `docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md` |
| Migrations are **never renamed**; every file must be idempotent and `information_schema`-guarded; DDL auto-commits | ADR-008; `scripts/migrate.mjs`; migration graph §1 |
| `uk_employee_identity_provider_subject (provider_id, provider_subject)` already forbids two links per subject | migration `012` |
| The auto-approve path already contradicts policy S9; its remediation is a **separate** item (S-01/S-02) | ADR-003; register X-04 |
| The evidence must never require a raw citizen ID to be re-verified | model §3 |

---

## 2. Decision

**Store the proof, not the claim.**

1. **New table `employee_identity_evidence`** — an append-only ledger of evidence items. Each row binds one
   evidence item to the provider subject, the immutable `employee_uid`, the link, the source, the observed
   timestamp, a validity window, the approving actor, and the evidence **type**.
2. **At the point of the lookup**, record a **keyed digest** of the (canonicalized) national ID —
   `lookup_digest` (64 lowercase hex, HMAC-SHA-256) — plus `lookup_key_version`, `digest_algorithm` and
   `lookup_domain`. **The raw id is never stored**, exactly as migration `015` already treats it.
3. **Verification is an equality query**, not a re-declaration: the evidence verifies iff its
   `lookup_digest` equals the digest on the **same employee's** `employee_identifier` `national_id` row under
   the **same** `lookup_key_version`, algorithm and domain (model §3.3). A missing match means **UNVERIFIED**.
4. **A declared boolean carries no authority.** Descriptive flags (`checksum_valid`) are recorded and never
   consulted by verification, so tampering with them changes nothing.
5. **Two new nullable columns on `employee_identity_links`: `evidence_type` and `enrichment_outcome`** — the
   first a deliberately denormalised mirror so a reviewer sees the evidence type without a join; the second
   the column the ID-7b ambiguity guard already reads and that the store has never had. The evidence table is
   the single source of truth; each mirror is guarded by a documented invariant, a single write path, and a
   drift query.
6. **Nothing is back-filled.** Pre-existing rows get `evidence_type = NULL` and `enrichment_outcome = NULL`,
   meaning "no evidence recorded" — never "evidence inferred".
7. **The proposal is not a migration.** The SQL lives in `database/proposals/025_identity_evidence.up.sql`
   (**not** `database/migrations/`), is **not in the ledger**, and is **not applied**.
8. **The same migration carries the ID-7b durable fix.** `enrichment_outcome` makes the outcome storable and
   readable, so the shipped fail-closed guard can relax from "the outcome must be *present*" to "the outcome
   must be an *allowed value*". Until then the guard refuses every enrichment link whose outcome the store
   cannot return, which is the intended posture; see the model §5.3 for the transition analysis (no window
   where an unapprovable link becomes approvable without new evidence).

Full column list, state machine, idempotency and retention: [`../IDENTITY_EVIDENCE_MODEL.md`](../IDENTITY_EVIDENCE_MODEL.md).
Threats and residual risks: [`../security/IDENTITY_EVIDENCE_THREAT_MODEL.md`](../security/IDENTITY_EVIDENCE_THREAT_MODEL.md).

---

## 3. Alternatives considered and rejected

| # | Alternative | Why rejected |
|---|---|---|
| **A1** | **Keep the boolean and store it** (`evidence_matched TINYINT` on the link) | This is the failure mode being fixed. A stored boolean is still an assertion: a copied flag verifies nothing. It adds a column and closes zero threats except "we forgot to record it". |
| **A2** | **Store the raw national ID on the evidence row**, encrypted (the migration `015` AES path) | Violates ADR-004's "raw storage disabled by default, needs a documented necessity"; adds a decryption surface and a PII blob to a **public** repository's schema; and is unnecessary — the digest answers "same value?" without ever revealing it. Retention/compliance cost with no verification gain. |
| **A3** | **Store the digest but no key version / algorithm / domain** | The digest is only comparable under a key version *and* the same domain-separated algorithm. Without the version, a rotation silently makes every historical digest incomparable, and a 64-hex value from any other HMAC use of the key could be mistaken for a lookup digest. Cheap fields, real failures. |
| **A4** | **Recompute the HMAC at verification time from a held raw id** | There is no raw id to hold — that is the entire point of the protection contract. Verification must be possible **without** plaintext or even key material (the equality query needs neither). |
| **A5** | **Columns on `employee_identity_links` only** (no new table) | The link has exactly one approval, but the design needs an append-only ledger with its own window and its own type, and the mirror/authority separation keeps the source of truth unambiguous. Columns-only also mixes "who approved" (link) with "what proved it" (evidence) in one row, which is what caused the current ambiguity. |
| **A6** | **Evidence table only** (no column on the link) | Rejected for reviewer ergonomics (G1b explicitly asks for the evidence type as a field) — but the cost is accepted: the mirror **can** drift because no MariaDB `CHECK` spans two tables. That risk is a **stated residual risk**, mitigated by one write path + the §5.2 drift query + C9. |
| **A7** | **Mirror an `evidence_id` FK on the link as well as `evidence.link_id`** | Circular foreign key: evidence needs the link, the link needs the evidence → a 3-statement insert and a fragile rollback order, for information `SELECT … WHERE link_id = ?` already returns. Rejected as complexity without capability. |
| **A8** | **Add an `'expired'` value to the link status ENUM** | Modifies an ENUM other code and the live schema depend on (the live ledger is pre-`013`, enum-order changes already hurt once — register C-04/T-03). Expiry is an evaluated property (model §4.3); the status stays as it is. |
| **A9** | **Put the SQL straight into `database/migrations/025_*.sql`** | `scripts/migrate.mjs` applies **every** file in that directory and the ledger keys on the filename with **no checksum**: a file that *looks* applyable is a production hazard. A proposal directory that states "not applied, not in the ledger" is the safe shape for an unapproved design. |
| **A10** | **Wait for a fully normalised model** (separate actor, source and validity tables) | Over-normalised for ≤ hundreds of rows and a single write path; more joins, more constraints, more migration risk, no additional verification power. YAGNI. |
| **A11** | **Do nothing; rely on the existing audit event** | The audit event records *that* a link was created, not *what matched*. It cannot close G1b and cannot distinguish a real lookup from an asserted one. |

---

## 4. Consequences

### 4.1 Positive

* **The claim becomes checkable.** A reviewer re-verifies an approval with one SQL equality query, needing
  neither the raw id nor the HMAC key (model §3.3). An unverifiable approval is now visibly unverifiable
  instead of looking like every other approval.
* **Tampering with the flag is a non-threat** (threat T2): the flag carries no authority by construction.
* **No new PII surface.** No raw id, no ciphertext, no key material; the digest is not reversible, so the
  public-repo constraint (ADR-010) holds.
* **Idempotency is enforced by the database**, not by a read-then-write check: the existing subject-unique key
  plus a new per-link, per-type unique key.
* **Backwards compatible.** Additive, nullable, no row rewritten, no migration renamed; `approved_by =
  'system:sso'` keeps its meaning (model §4.2).
* **The ID-7b ambiguity guard becomes enforceable on the real store.** `enrichment_outcome` is the column the
  guard already reads and the store has never had; once it exists and both twins persist it, the shipped
  fail-closed guard relaxes from "present" to "an allowed value" with **no guard change** (model §5.3.4).

### 4.2 Costs and risks

| Cost / risk | Detail |
|---|---|
| **Migration cost** | One new table (with 3 FKs, 4 indexes, 3 CHECKs) + one nullable column + one FK. Requires MariaDB ≥ 10.2.3 for the enforced CHECKs (the same floor as `015`). On the live host it is part of the **unapplied** `013`-`017` gap and cannot be applied alone. |
| **Operational cost** | The runtime must be changed to compute and insert the digest at the lookup point — **not** in this design track. Back-filling is intentionally impossible: historical `system:sso` approvals stay **unverifiable**, and that must be reported, not hidden. |
| **Drift risk (accepted)** | `employee_identity_links.evidence_type` can disagree with the evidence ledger (no cross-table CHECK). Mitigated by a single write path, the drift query and test C9; still a residual risk. |
| **Verification goes stale after key rotation** | Evidence keeps its original `lookup_key_version`; after a reindex the employee's digest moves version and equality fails. The honest handling is "unverifiable under the current key set → re-confirm", not "try both versions". Needs an operational note when a rotation is next performed. |
| **Forgery by a fully privileged writer** | Equality is a proof over the *store*; a writer who can read `employee_identifier` and write the evidence table can construct a consistent forgery (threat T3). Needs DB role separation and/or the deferred append-only trigger. **The largest unmitigated risk.** |
| **Sessions outlive revocation** | Revocation does not invalidate an issued access token and `refresh` does not re-check the link (threat T6) — a **known gap, unchanged by this ADR**. |
| **Enrichment links are unapprovable until `025` lands** | The shipped fail-closed guard (ID-7b) refuses any enrichment link whose outcome the store cannot return. That is the intended posture, not a regression, but it is a real functional consequence of sequencing `025` after the guard: until then, `mju_person_enrich`/`person_api_enrich` links stay `candidate` (model §5.3). |
| **Retention** | Nothing expires the evidence row; it can outlive employment (threat T7). Needs an owner/privacy policy, left open rather than invented. |

---

## 5. Status and next steps

**Status: `PROPOSED - NOT APPROVED`.** This ADR authorises **no** work. Specifically it is **not** approval to
move the SQL into `database/migrations/`, apply anything, write runtime code, create/rotate a key, or change
production.

If approved, the work splits into separately-approved changes:

1. this ADR + the model/threat/test documents (this track);
2. the migration moved into `database/migrations/` with a **new** filename decision frozen at that point
   (ADR-008: filenames are immutable once applied);
3. the runtime write/read path (compute the digest at the lookup, insert the evidence, evaluate expiry);
4. **twin parity (ID-7b precondition):** both repositories must persist/return `enrichment_outcome`, and
   `backend/tests/identityLinkEnrichment.mariadb.test.js` must be updated from "pins the absence" to "asserts
   the round trip" — it fails by design the moment the column lands (model §5.3.5);
5. the DB role/trigger decision if the T3 residual is to be reduced.

| Linked document | Role |
|---|---|
| [`../IDENTITY_EVIDENCE_MODEL.md`](../IDENTITY_EVIDENCE_MODEL.md) | the schema, state machine, idempotency, retention |
| [`../security/IDENTITY_EVIDENCE_THREAT_MODEL.md`](../security/IDENTITY_EVIDENCE_THREAT_MODEL.md) | threats T1–T9 and residual risks |
| [`../security/IDENTITY_EVIDENCE_TEST_PLAN.md`](../security/IDENTITY_EVIDENCE_TEST_PLAN.md) | adversarial tests + mutation schedule |
| [`../../database/proposals/README.md`](../../database/proposals/README.md) | why the SQL is a proposal, not a migration |
