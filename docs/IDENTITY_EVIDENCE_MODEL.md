# Identity evidence model (ID-6b / S-02)

**Status:** `DESIGN — PROPOSED, NOT APPROVED`. **Nothing here is executed, applied or wired.**
**Date:** 2026-10-16 · **Track:** ID-6b / S-02 · **Migration:** `database/proposals/025_identity_evidence.*.sql` (proposal only)
**Companions:** [`IDENTITY_MAPPING_CONTRACT.md`](IDENTITY_MAPPING_CONTRACT.md) (G1b), [`IDENTITY_INTEGRATION_AUDIT.md`](IDENTITY_INTEGRATION_AUDIT.md) (F3),
[`adr/ADR-011-identity-evidence-storage.md`](adr/ADR-011-identity-evidence-storage.md),
[`security/IDENTITY_EVIDENCE_THREAT_MODEL.md`](security/IDENTITY_EVIDENCE_THREAT_MODEL.md),
[`security/IDENTITY_EVIDENCE_TEST_PLAN.md`](security/IDENTITY_EVIDENCE_TEST_PLAN.md).

Labels used below: **VERIFIED** (read in the code/schema today, with a file reference) · **ASSESSED** (reasoned, not observed) ·
**UNKNOWN** (not determinable from this repository).

---

## 1. The problem this closes

The SSO first-login path creates an **APPROVED** link with `approvedBy: 'system:sso'`
(`backend/src/services/identityResolutionService.js` `linkProviderSubjectFromSsoLogin`, insert at
`identityResolutionService.js:329-340`) and refuses to do so unless the caller **declares**

```js
evidence: { nationalIdLookupMatched: true }   // ssoIdentityResolutionService.js:164-166
```

The service's own comment states the honest limitation (**VERIFIED**, `identityResolutionService.js:288-295`):
the assertion is a **contract check, not a proof**. The HMAC lookup happens in another layer
(`employeeIdentity.resolve('national_id', …)`), the link layer holds no raw identifier, and **the declaration
is not stored**. After the fact, a reviewer has:

| Today's trace | Enough to verify the claim? |
|---|---|
| `approved_by = 'system:sso'` | No — names the actor, not the evidence |
| `source = 'sso_national_id_resolution'` | No — a label the same caller supplies |
| `subject_type` | No — describes the subject's shape, not the lookup |
| the `sso_provider_link` audit event | No — records that a link happened, not what was matched |

So the boolean is **unverifiable after the fact** (audit finding class relevant to
`docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md` §5.1: *"a guard that can be walked around"* — here, a
*proof* that can be asserted into existence). ID-6b is to make the evidence **durable** (stored) and
**verifiable** (re-checkable later without trusting the caller's word).

**Design rule, stated once:** *a reviewable fact must be re-derivable from stored data, never re-asserted by
the code that consumed it.*

---

## 2. The evidence record

One new table: **`employee_identity_evidence`**. One new column on the existing link table:
**`employee_identity_links.evidence_type`**.

An evidence row binds a trusted fact to the seven things the design must bind. Column names, types and
nullability are reproduced exactly as proposed in the migration:

| # | Binds | Column | Type | NULL? | Why NULL / NOT NULL |
|---|---|---|---|---|---|
| — | identity of the row | `evidence_id` | `BIGINT UNSIGNED NOT NULL AUTO_INCREMENT` | no | PK. `BIGINT` (not `INT`) because evidence is append-only and expected to outlive link churn |
| (g) | evidence **type** | `evidence_type` | `ENUM('sso_national_id_lookup','operator_review','enrichment_corroboration') NOT NULL` | **no** | An evidence row without a type is not evidence. The ENUM (not free text) is the same closed-set discipline as `IDENTITY_LINK_SOURCES` |
| (b) | immutable `employeeUid` | `employee_uid` | `VARCHAR(36) NOT NULL` | **no** | The canonical identity is never null; FK → `employees` |
| (a) | verified provider subject | `provider_subject` | `VARCHAR(255) NOT NULL` | **no** | Matches the link column's width so the same value can be compared byte-for-byte |
| (a) | provider | `provider_id` | `INT(11) NOT NULL` | **no** | FK → `identity_providers`; the subject is only meaningful within its provider |
| (a) | subject shape | `subject_type` | `VARCHAR(64) NOT NULL DEFAULT 'opaque'` | no | Mirrors the link; keeps the evidence self-describing without a join |
| — | the link it justifies | `link_id` | `INT(11) NOT NULL` | **no** | FK → `employee_identity_links(id)` `ON DELETE RESTRICT`. NOT NULL because evidence in this design is always *about* a link, and RESTRICT because an evidence ledger must not be orphaned by a link delete |
| (c) | source | `source` | `VARCHAR(64) NOT NULL` | **no** | Mirrors `IDENTITY_LINK_SOURCES`; NOT NULL because provenance is the whole point |
| (d) | observed timestamp | `observed_at` | `DATETIME NOT NULL` | **no** | Server clock at the moment the lookup/approval happened. Stored as `DATETIME` (UTC wall time) like every other timestamp in this schema |
| (d) | observed by | `observed_by` | `VARCHAR(128) NOT NULL` | **no** | The acting principal (`sso:callback`, an operator id). Distinct from the approving actor: the observer and the approver need not be the same |
| (e) | validity window start | `valid_from` | `DATE NOT NULL` | **no** | Inclusive. NOT NULL because "valid from when" must be answerable |
| (e) | validity window end | `valid_until` | `DATE NULL DEFAULT NULL` | **yes** | `NULL` = unbounded, exactly the `employee_identifier.effective_to` convention (migration `020`). NULL must mean "open", never "expired at epoch" |
| (f) | approving actor | `approving_actor` | `VARCHAR(128) NOT NULL` | **no** | Who/what performed the transition to the state this evidence supports (`system:sso` or a human id) |
| (f) | why | `approval_reason` | `VARCHAR(255) NOT NULL` | **no** | A short, non-PII reason token (audit-text rules apply: no 10+ digit runs) |
| — | screening outcome | `checksum_valid` | `TINYINT(1) NOT NULL DEFAULT 0` | no | **Recorded, never trusted.** See §3 — this is the flag that replaces today's trust-me boolean |
| (proof) | keyed digest | `lookup_digest` | `VARCHAR(64) NULL DEFAULT NULL` | **yes** | Lowercase hex HMAC-SHA-256. NULLable because only `sso_national_id_lookup` evidence carries one; a `CHECK` enforces that it is NOT NULL exactly when the type demands it |
| (proof) | key version | `lookup_key_version` | `SMALLINT UNSIGNED NULL DEFAULT NULL` | **yes** | Which HMAC key produced the digest, mirroring `employee_identifier.lookup_key_version` |
| (proof) | algorithm | `digest_algorithm` | `VARCHAR(16) NULL DEFAULT NULL` | **yes** | e.g. `hmac-sha256`. Recorded so a future algorithm change cannot silently compare unequal things |
| (proof) | domain | `lookup_domain` | `VARCHAR(64) NULL DEFAULT NULL` | **yes** | The `LOOKUP_DOMAIN` constant (`rae-attendance-v2:identifier-lookup:v1`, **VERIFIED** in `nationalIdContract.js:25`). Separates the lookup digest from any other HMAC use of the same key |
| — | row creation | `created_at` | `DATETIME NOT NULL` | no | Append-only: there is deliberately **no `updated_at`** — a mutable evidence row is not evidence |

**What is NOT a column, on purpose:** no raw citizen ID, ever (ADR-004, migration `015`'s digest pattern); no
`lookup_hmac` duplicate of the employee's own row (that lives in `employee_identifier`); no `approved_by`
duplicate (that stays on the link, §5).

**Why the digest column keeps the utf8mb4_unicode_ci collation** (**VERIFIED** convention): the verification
join compares it to `employee_identifier.id_value`, which is `utf8mb4_unicode_ci` (migration `003`/`013`). A
different collation would risk a collation-mix error on the join. The lowercase-hex `CHECK` makes the
case-insensitive collation harmless.

---

## 3. Verifying the national-ID lookup claim (the heart of ID-6b)

### 3.1 What is stored

At the moment the lookup actually happens — inside `employeeIdentity.resolve('national_id', …)`, which is
where the digest already exists as `buildLookup()` output (**VERIFIED**, `nationalIdContract.js:169-172`) —
the SSO path additionally records, into the evidence row:

* `lookup_digest` = the same lowercase-hex HMAC-SHA-256 that was used as the lookup key,
* `lookup_key_version` = the key version that produced it,
* `digest_algorithm` = `hmac-sha256`,
* `lookup_domain` = the lookup domain constant,
* `checksum_valid` = the screening outcome **as observed at that moment** (descriptive only).

A boolean `nationalIdLookupMatched` is therefore **not stored as proof**. If a boolean is stored at all it is
descriptive and must never be the basis of a verification — the digest is.

### 3.2 The honest answer: is the digest alone enough?

**No — a keyed digest alone does NOT re-verify the lookup claim.** Precisely:

| The digest alone proves | The digest alone does NOT prove |
|---|---|
| Some value was canonicalized and HMAC'd under a stated key version and domain | That a lookup *was performed*, or when |
| The value is **equal** to any other value that yields the same digest under the same key version (it is an *equality oracle*, not a plaintext archive) | That the digest was computed from the value actually presented at login rather than written by whoever could write the table |
| Nothing about the plaintext (a 13-digit id cannot be recovered from it, and 10¹³ guesses through HMAC is not feasible) | That the id was the person's **genuine** citizen id — only that it is the same id V2 already bound to that employee |

### 3.3 What makes it a verification

The digest becomes a proof only when it is compared against the **employee's own binding**. The verification
procedure is a single equality query (no key material and no plaintext required by the reviewer):

```sql
-- "Is the lookup claim on this evidence row actually true?"
SELECT 1
FROM employee_identity_evidence e
JOIN employee_identifier i
  ON i.employee_uid         = e.employee_uid
 AND i.id_type              = 'national_id'
 AND i.id_value             = e.lookup_digest
 AND i.lookup_key_version   = e.lookup_key_version
WHERE e.evidence_id = ?
  AND e.evidence_type = 'sso_national_id_lookup'
  AND e.digest_algorithm = 'hmac-sha256'
  AND e.lookup_domain    = 'rae-attendance-v2:identifier-lookup:v1';
```

* **Row present** ⇒ the digest recorded at login equals the digest V2 has bound to *that employee's*
  `national_id` row, under the *same* key version. Because HMAC is deterministic and keyed, the value
  presented at login was the same citizen id V2 bound to that employee (up to canonicalization
  equivalence — see residual risk R1). This is a real **same-binding proof**, not a re-declaration.
* **Row absent** ⇒ the claim is **NOT verified**. The row must be treated as *unverified*, not merely *old*.
  This is the fail-closed direction and the difference from today.
* **Cross-employee check** (the other half): the same query with `i.employee_uid <> e.employee_uid` must
  return **nothing** — if a digest under one key version resolves to two employees, that is a defect, not a
  match.

### 3.4 What is still needed beyond the digest

State plainly, because the brief asks for the honest list:

1. **The employee's `employee_identifier` national_id row must still exist.** The proof is a *comparison*, so
   the comparison target is a dependency. If the binding is deleted or reindexed to a new key version, the
   evidence becomes **stale/unverifiable** (see R2) — a state the design must surface, not hide.
2. **Key-version continuity.** After a key rotation + `planReindex()` the employee row moves to the new
   version while the evidence keeps the old one. Equality then fails. The honest handling is to record the
   evidence as *unverifiable under the current key set* and require a re-confirmation, not to "try both
   versions and call it a match".
3. **An immutable store.** Digest equality is a proof *over the stored data*; an actor with write access to
   both tables can construct a matching pair. That is a privilege/DB-integrity control, not a cryptographic
   one (§7, threat T3).
4. **A trustworthy upstream binding.** The chain's root is whatever onboarding wrote
   `employee_identifier.id_value`. Evidence cannot be stronger than that source (audit **F3**: plaintext PII
   at rest elsewhere).

### 3.5 Failure modes the recorded fields make detectable

| Symptom | Detected by |
|---|---|
| Digest present, no matching `employee_identifier` row | verification query returns 0 rows |
| Digest resolves to a *different* employee | cross-employee variant of the query returns a row |
| Digest present but key version or domain missing (partial write) | `chk_identity_evidence_lookup` (DB CHECK) refuses the insert |
| Digest not 64 lowercase hex | `chk_identity_evidence_digest_shape` (DB CHECK) refuses the insert |
| The claimed type is `sso_national_id_lookup` but no digest exists | `chk_identity_evidence_lookup` refuses the insert |

---

## 4. State machine

States are the **existing** link states (**VERIFIED**, `domain/identityLink.js` `LINK_STATUS`):
`candidate`, `approved`, `rejected`, `revoked`. **This design does not add a state and does not modify the
link ENUM** (deliberate: an ENUM modification rewrites a column other code and the live schema depend on —
see ADR-011 alternatives). Expiry is an **evaluated property** (§4.3), not a state.

| Transition | Who may perform it | Required evidence | Existing code | Status after |
|---|---|---|---|---|
| `∅ → candidate` | operator/admin via `createCandidate`; automated ingestion as candidate-only | `evidence_type ∈ {operator_review, enrichment_corroboration}` **optional** (a candidate is by definition unproven) | `identityResolutionService.createCandidate` (**VERIFIED**) | `candidate` |
| `candidate → approved` | **human** HR/admin (`approvedBy` required, **VERIFIED** `approve()`) | `evidence_type = 'operator_review'` with `approving_actor` = the human id. A machine-sourced evidence type is not acceptable for a human transition | `approve()` | `approved` |
| `∅ → approved` | **system** (`system:sso`), SSO first-login only | `evidence_type = 'sso_national_id_lookup'` **with a non-null `lookup_digest` + `lookup_key_version`**, plus the existing declared-lookup contract check | `linkProviderSubjectFromSsoLogin` (**VERIFIED**) | `approved` |
| `candidate → rejected` | human HR/admin (`rejectedBy`) | `evidence_type` optional; `approval_reason` required | `reject()` | `rejected` |
| `approved → revoked` | human HR/admin (`revokedBy`), or system for a mismatch/binding-invalid event | `evidence_type` = the type being invalidated; `approval_reason` = the reason | `revoke()` (**VERIFIED**) | `revoked` |
| `approved → expired` | **nobody** — not a stored transition | evaluated from `valid_until` at read time | **does not exist** (see §4.3) | still `approved` in the DB |
| `revoked → approved` | **not allowed** | — | no code path; also blocked by the subject-unique key | — |
| `rejected → *` | **not allowed** | — | no code path | — |

Two invariants a transition must maintain:

* **I1 — one evidence item of a type per link:** `UNIQUE (link_id, evidence_type)` (§6). A second `approved`
  transition on the same link must not silently add a second body of evidence.
* **I2 — the mirror never disagrees:** `employee_identity_links.evidence_type` must equal the evidence row's
  `evidence_type` wherever a row exists (§5).

### 4.1 Direct-insert vs transition (the honesty note)

The SSO path does **not** move `candidate → approved`; it **inserts an already-`approved`** row. That is the
documented discrepancy between policy S9 and the code (ADR-003 / conflict **X-04**, "the code is the
defect"). This design does not fix that (it is a runtime change, track-blocked); it makes the insert carry a
**checkable** evidence row so the report of what happened is at least verifiable. Bringing the SSO insert into
the candidate-then-approve flow stays open as a separate item.

### 4.2 `approvedBy: 'system:sso'` remains interpretable

`employee_identity_links.approved_by` is **not** changed, renamed or back-filled, so:

* existing rows keep a value whose meaning is unchanged (`system:sso` = an automated SSO approval),
* a reviewer reading only the link gets the same answer as before,
* the new `evidence_type` column **adds** the "what evidence" dimension; `approved_by` keeps the "who" — the
  two are complementary and neither replaces the other.

A nullable `evidence_type` means: **`NULL` = no evidence recorded** (every pre-ID-6b row). It must never be
read as "no evidence was needed".

### 4.3 Expiry

`valid_until NULL` = unbounded (mirrors `employee_identifier.effective_to`, migration `020`). An expired
evidence item does **not** change any status; it makes the link's approval **stale**, and a read path that
wants to honour expiry must evaluate `valid_until IS NULL OR valid_until >= <wall date>`. **The current
`resolve()` does not do this** (**VERIFIED**) — adding it is activation-phase code, not this design. Until it
exists, expiry is *recorded but not enforced*; that is stated rather than implied. The wall-date comparison
must use `wallDateOnly()` (`backend/src/utils/bangkokTime.js`) — never `String(value).slice(0,10)`
(NEXT_ACTIONS standing rule 1).

---

## 5. Interaction with the existing tables

| Existing table | Change | Justification |
|---|---|---|
| `employee_identity_links` | **add one nullable column:** `evidence_type` `ENUM(...) NULL` | G1b asks for the evidence TYPE as its own field so a reviewer does not need a join. The authoritative record is the evidence table; this column is an explicitly **denormalised mirror** (invariant I2). It is the **only** change to an existing table. |
| `employee_identifier` | **no change** | The national_id row already holds the comparison target (`id_value` = digest, `lookup_key_version`). Adding a pointer would duplicate a digest that is already there and create a second source of truth. |
| `identity_providers` | **no change** | Evidence FKs to `id`; the provider is already the tenant of the subject. |
| `employee_identity_links.approved_by` / `approved_at` / `source` | **no change, no back-fill** | Preserves the interpretability of `system:sso` (§4.2) and avoids rewriting historical rows — a back-fill would *invent* evidence for rows that had none. |

### 5.1 New table **and** new column — why both

A new column alone cannot express an append-only, multi-type ledger with its own validity window; a new table
alone cannot give the reviewer the evidence type without a join. So the design uses both, with a single
source of truth (the table) and one clearly-labelled denormalised mirror (the column), rather than two
authoritative copies.

**Alternative rejected** (recorded in ADR-011): a mirrored `evidence_id` FK on the link in addition to
`evidence.link_id`. That is a **circular foreign key** — evidence needs the link, the link needs the evidence
— forcing a three-statement insert (`link` → `evidence` → `UPDATE link`) and a fragile rollback order, for
information that `SELECT … WHERE link_id = ?` already returns. Rejected as complexity without a capability.

### 5.2 The drift query (invariant I2, runnable)

```sql
-- Returns every link whose mirror disagrees with its evidence ledger. MUST return 0 rows.
SELECT l.id, l.evidence_type
FROM employee_identity_links l
LEFT JOIN employee_identity_evidence e
  ON e.link_id = l.id
 AND e.evidence_type = l.evidence_type
WHERE l.evidence_type IS NOT NULL
  AND e.evidence_id IS NULL;
```

No DB `CHECK` can span the two tables (MariaDB CHECK constraints are row-local), so invariant I2 is enforced
at the **single write path** and detected by this query + a test. That limitation is a stated residual risk,
not a papered-over one.

---

## 6. Idempotency and concurrency

### 6.1 The two constraints, named

| Constraint | Where | What it prevents |
|---|---|---|
| **`uk_employee_identity_provider_subject (provider_id, provider_subject)`** | exists today, migration `012` (**VERIFIED**) | two links (hence two approved links) for one provider subject — application-wide, **forever**, regardless of employee |
| **`uk_identity_evidence_link_type (link_id, evidence_type)`** | **new**, this proposal | two evidence items of the same type on one link |

Because at most one link can exist per subject, and at most one evidence item of a given type per link, a
subject can hold **at most one `sso_national_id_lookup` evidence row**.

### 6.2 A replayed SSO first-login

`linkProviderSubjectFromSsoLogin` already short-circuits: if a link exists for the subject it returns it
**without inserting** (and never promotes a non-approved row — the S9 guard). So a replay produces:

* **no** second link,
* **no** second evidence row,
* the same session behaviour as before.

The DB unique keys are the backstop for a caller that does not short-circuit.

### 6.3 The race, and its exact failure mode

Two instances handle the **same** subject's first login concurrently:

```
A: findByProviderSubject -> null      B: findByProviderSubject -> null
A: findApprovedForEmployee -> null    B: findApprovedForEmployee -> null
A: INSERT link  -> ok
B: INSERT link  -> ER_DUP_ENTRY on uk_employee_identity_provider_subject
```

* The application-level `findApprovedForEmployee` check is **not** a constraint and cannot prevent the race
  (**VERIFIED**: it is a read, not a lock).
* The **exact** failure mode today is a raw driver error (`ER_DUP_ENTRY`) surfacing as a **500**, not a clean
  `409`. One *session* may be handed out by A; B fails. **No duplicate approved link is ever created** —
  that is exactly what the unique key guarantees. Turning the 500 into an idempotent re-read is an
  **activation-phase code change**, listed in the test plan; the design's job is that the invariant is
  enforced by the database, which it is.
* Same shape for evidence: the loser never reaches the evidence insert (it fails at the link insert first),
  and even if it did, `uk_identity_evidence_link_type` would refuse the duplicate.

---

## 7. Revocation, expiry and already-issued sessions (the honest answer)

**A token is not revoked until it expires. That is a known gap, and this design does not close it.**

| Artifact | On link revocation / evidence expiry | Evidence |
|---|---|---|
| **Access token** | **Unaffected.** It is a stateless signed JWT; no revocation list exists. It remains valid until its own `exp` | **VERIFIED** — `signAccessToken` in `services/sso/ssoTokens.js`; nothing consults the link at request time |
| **Refresh token** | **Unaffected until it is used and rotated.** `authService.refresh` validates only the refresh-token row (existence, `revokedAt`, `expiresAt`) and **never re-checks the identity link or the employee's active status** | **VERIFIED** — `authService.js:95-123` |
| **The link row** | `status='revoked'`; `resolve()` refuses new sessions (`IDENTITY_NOT_APPROVED`) | **VERIFIED** — `identityResolutionService.resolve` |
| **Evidence row** | Not deleted. Retention is deliberate (§8); `valid_until` may be set to the revocation date to record the close of the window | **ASSESSED** |

Consequences a reviewer must not be told otherwise about:

1. **Revocation is "no new sessions", not "no session".** An already-issued access token lives out its
   lifetime; an already-issued refresh token can be rotated into a new access token until `expiresAt`
   (default `config.jwt.refreshTokenDays`).
2. **There is no automatic "revoke my sessions" on link revocation.** Closing the gap needs either a
   revocation check in `refresh` (cheap, targeted) and/or a token denylist (a real design item — out of
   scope here).
3. **Expiry is weaker than revocation** even when enforced, because it is evaluated only where the code
   chooses to evaluate it. Today that is nowhere.

This is recorded as a **known gap** in the threat model (T6) and the test plan (it is asserted as *current
behaviour*, so a future fix that changes it is noticed rather than assumed).

---

## 8. Row growth and retention

| Question | Answer |
|---|---|
| How many rows? | One per transition that carries evidence. The dominant producer is an SSO first-login: **≤ 1 row per distinct provider subject** (= ≤ 1 per employee holding an SSO identity). With the confirmed 50-person scope that is **tens of rows**, and ~1 row per future human approval/rejection/revocation |
| Growth rate | **O(employees + grant changes)**, i.e. effectively bounded — not an append-per-request log |
| Row size | ~400 bytes (digest 64 B + two dozen short fields) — under 100 KB for the whole scope |
| Retention | **Identity-scoped, not attendance-scoped.** It is the provenance for an access grant, so it is kept for the life of the link. It holds **no raw PII** (digest only; masked output is never stored), so PDPA retention pressure is low; the pressure that exists is "keep the accountability record", not "delete the sensitive field" |
| The uncomfortable part | **Nothing expires the evidence row automatically, and the row can outlive the employment relationship** (threat T7). `valid_until` bounds the *access window*, not the *retention*. A retention policy (align to the employee record lifecycle, or a documented minimum) is an **owner/privacy decision**, not an engineering default, and is left open rather than invented |

---

## 9. Scope boundaries and open items

**In this design:** the evidence table, the mirror column, the digest-based verification, the state table,
the idempotency constraints, the threat model and the adversarial test plan.

**Deliberately NOT in this design:**

* **Effective dating of the link** (contract §5, open item **G3**) — a separate decision. Evidence carries its
  own window; the link does not gain one here.
* **Any runtime code.** No repository, service, route or test is written by this track; the proposal is
  documents + SQL only.
* **No DB-enforced append-only trigger.** A `BEFORE UPDATE`/`BEFORE DELETE` guard would make immutability
  real, but triggers need `SUPER`/`log_bin_trust_function_creators` on a binary-logged host — a deploy
  constraint migration `017` already documented (**VERIFIED**, `database/migrations/017_identifier_namespace_claim.sql:20-21`).
  Deferred; recorded as residual risk R3.
* **No back-fill.** Existing `system:sso` rows get `evidence_type = NULL`, which honestly means "no evidence
  recorded", not "evidence invented after the fact".

**Open items for the owner (feeding ADR-011 and the register):**

| # | Item | Decision needed |
|---|---|---|
| E1 | Approve migration `025` as a real migration (move out of `database/proposals/`) | owner + DBA, separate approved change |
| E2 | Retention policy for identity evidence | owner + privacy officer |
| E3 | Whether to close the session-revocation gap (§7) | owner — separate design |
| E4 | Whether the SSO direct-insert should become candidate→approve (§4.1) | owner — separate design (S-01/S-02) |
| E5 | Whether to `BUILD` the DB-level append-only trigger (§9) despite the privilege cost | DBA |
