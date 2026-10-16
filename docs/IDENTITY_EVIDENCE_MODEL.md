# Identity evidence model (ID-6b / S-02)

**Status:** `DESIGN — PROPOSED, NOT APPROVED`. **Nothing here is executed, applied or wired.**
**Date:** 2026-10-16 · **Track:** ID-6b / S-02 · **Migration:** `database/proposals/025_identity_evidence.*.sql` (proposal only)
**Revised 2026-10-16 (Track B review):** reconciled with the shipped **ID-7b fail-closed enrichment guard**
and the ID-6 / ID-7 hardening — see §1.1 for what landed and §5.3 for how `025` stays the durable fix.
**Companions:** [`IDENTITY_MAPPING_CONTRACT.md`](IDENTITY_MAPPING_CONTRACT.md) (G1b; findings **F3/F4** — the inert outcome guard),
[`IDENTITY_INTEGRATION_AUDIT.md`](IDENTITY_INTEGRATION_AUDIT.md) (the enrichment-source audit),
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
evidence: { nationalIdLookupMatched: true }   // ssoIdentityResolutionService.js:162-165
```

The service's own comment states the honest limitation (**VERIFIED**, `identityResolutionService.js:288-294`):
the assertion is a **contract check, not a proof**. The HMAC lookup happens in another layer
(`employeeIdentity.resolve('national_id', …)`), the link layer holds no raw identifier, and **the declaration
is not stored**. After the fact, a reviewer has:

| Today's trace | Enough to verify the claim? |
|---|---|
| `approved_by = 'system:sso'` | No — names the actor, not the evidence |
| `source = 'sso_national_id_resolution'` | No — a label the caller supplies. It is now constrained to the frozen `IDENTITY_LINK_SOURCES` allowlist (hardening **ID-7**) and an unknown source is refused at creation, so it is no longer *arbitrary*; but it is still *chosen by the caller*, so it names a claimed method, not the matched value |
| `subject_type` | No — describes the subject's shape, not the lookup |
| the `sso_provider_link` audit event | No — records that a link happened, not what was matched |

So the boolean is **unverifiable after the fact** (audit finding class relevant to
`docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md` §5.1: *"a guard that can be walked around"* — here, a
*proof* that can be asserted into existence). ID-6b is to make the evidence **durable** (stored) and
**verifiable** (re-checkable later without trusting the caller's word).

**Design rule, stated once:** *a reviewable fact must be re-derivable from stored data, never re-asserted by
the code that consumed it.*

### 1.1 What the ID-6 / ID-7 hardening already changed (and what it did not)

Two hardening passes landed on this branch **before** this design, and this document reflects them:

| Hardening | What it now does (**VERIFIED** in the code today) | What it does **not** do |
|---|---|---|
| **ID-6** (finding F1) | The e-mail-shaped / callback-`ac` / malformed / oversized subject guard is defined **once** in `domain/identityLink.js` (`rejectionCodeForProviderSubject`) and called by **both** creation paths — so `createCandidate` **does** guard e-mail-shaped subjects now, and an earlier draft that said it did not is obsolete | It does not make the *subject* verified identity proof, and it does not touch the declared-lookup boolean |
| **ID-7** (finding F2) | `IDENTITY_LINK_SOURCES` is a **frozen allowlist**; an unknown `source` is refused at creation (`400 IDENTITY_SOURCE_UNKNOWN`) on both paths, so provenance cannot be asserted into existence | It does not make the stored `source` *evidence* of the lookup — see the table above |
| **ID-7b** (findings **F3/F4**) | `enrichmentBlocksApproval` now fails **closed** on an absent/unknown enrichment outcome (a frozen `ALLOWED_ENRICHMENT_OUTCOMES` allowlist), so the half of the ambiguity guard that was inert on MariaDB now bites | It is a **stop-gap**: it makes enrichment links unapprovable until the outcome can be *read from the store*. The durable fix is migration `025` — §5.3 |

The declared-lookup boolean is untouched by all three: it is still a **contract check, not a proof**, and
that is exactly what this design exists to replace.

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
| (ID-7b) | enrichment outcome | `enrichment_outcome` | `ENUM('found','ambiguous','not_found','timeout','api_error','fallback','firstname_only') NULL DEFAULT NULL` | **yes** | §5.3. The append-only record of what an `enrichment_corroboration` row's enrichment returned. `NULL` = no outcome recorded, which is **not** `found` and must never be read as success. A `CHECK` requires it exactly when `evidence_type='enrichment_corroboration'` |
| (proof) | keyed digest | `lookup_digest` | `VARCHAR(64) NULL DEFAULT NULL` | **yes** | Lowercase hex HMAC-SHA-256. NULLable because only `sso_national_id_lookup` evidence carries one; a `CHECK` enforces that it is NOT NULL exactly when the type demands it |
| (proof) | key version | `lookup_key_version` | `SMALLINT UNSIGNED NULL DEFAULT NULL` | **yes** | Which HMAC key produced the digest, mirroring `employee_identifier.lookup_key_version` |
| (proof) | algorithm | `digest_algorithm` | `VARCHAR(16) NULL DEFAULT NULL` | **yes** | e.g. `hmac-sha256`. Recorded so a future algorithm change cannot silently compare unequal things |
| (proof) | domain | `lookup_domain` | `VARCHAR(64) NULL DEFAULT NULL` | **yes** | The `LOOKUP_DOMAIN` constant (`rae-attendance-v2:identifier-lookup:v1`, **VERIFIED** in `nationalIdContract.js:25`). Separates the lookup digest from any other HMAC use of the same key |
| — | row creation | `created_at` | `DATETIME NOT NULL` | no | Append-only: there is deliberately **no `updated_at`** — a mutable evidence row is not evidence |

> **Appendix A parity note — RESOLVED 2026-10-16 by the orchestrator.** The two `enrichment_outcome` columns
> required by ID-7b (§5.3, and the row above) have been **merged into the embedded DDL in Appendix A of this
> file**: `employee_identity_evidence.enrichment_outcome` (the append-only authority, with a `CHECK` requiring
> it exactly when `evidence_type = 'enrichment_corroboration'`) and
> `employee_identity_links.enrichment_outcome` (the guard-read mirror, added by its own guarded
> prepared-statement block). The appendix and §2/§5.3 now agree.
>
> Two defects were found and fixed **while** merging, and they are recorded because neither was visible to
> structural linting:
>
> 1. The merge itself first produced **malformed SQL** — a comment and a whole statement spliced inside an
>    `IF(...)` expression, truncating it and leaving an orphaned statement. Repaired into two separately
>    guarded blocks (one per column), which is also more correct: each column needs its own existence check to
>    stay idempotent when only one was applied.
> 2. The first guarded block in the **down** proposal checked `COLUMN_NAME = 'evidence_type'` but **dropped**
>    `enrichment_outcome`. Executed as written it would try to drop a non-existent column (or skip a real one)
>    depending on partial-apply state. Each guard now names the column it actually drops, verified by a
>    pairing check rather than by reading alone.
>
> The SQL is **structurally** verified (balanced `PREPARE`/`EXECUTE`/`DEALLOCATE`, no truncation, guards
> paired to their columns). It has **not been executed** — 025 remains a proposal outside the ledger.

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
| `∅ → candidate` | operator/admin via `createCandidate`; automated ingestion as candidate-only | `evidence_type ∈ {operator_review, enrichment_corroboration}` **optional** (a candidate is by definition unproven). The `source` must be a member of the frozen `IDENTITY_LINK_SOURCES` allowlist and the subject must pass the ID-6 subject guard — both are enforced at creation (**VERIFIED**) | `identityResolutionService.createCandidate` (**VERIFIED**) | `candidate` |
| `candidate → approved` | **human** HR/admin (`approvedBy` required, **VERIFIED** `approve()`) | `evidence_type = 'operator_review'` with `approving_actor` = the human id. A machine-sourced evidence type is not acceptable for a human transition. If the link's `source` is an **enrichment** source, the outcome must be present **and** allowlisted (§5.3, `enrichmentBlocksApproval`) | `approve()` | `approved` |
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
| `employee_identity_links` | **add two nullable columns:** `evidence_type` `ENUM(...) NULL` and `enrichment_outcome` `ENUM(...) NULL` | `evidence_type` (G1b) gives a reviewer the evidence TYPE without a join; `enrichment_outcome` (§5.3, **ID-7b**) is the column the ambiguity guard already reads and that the store has never had. Both are explicitly **denormalised mirrors** of the ledger/invariant, guarded by a single write path. These are the **only** changes to an existing table. |
| `employee_identifier` | **no change** | The national_id row already holds the comparison target (`id_value` = digest, `lookup_key_version`). Adding a pointer would duplicate a digest that is already there and create a second source of truth. |
| `identity_providers` | **no change** | Evidence FKs to `id`; the provider is already the tenant of the subject. |
| `employee_identity_links.approved_by` / `approved_at` / `source` | **no change, no back-fill** | Preserves the interpretability of `system:sso` (§4.2) and avoids rewriting historical rows — a back-fill would *invent* evidence for rows that had none. |

### 5.1 New table **and** new columns — why both

A new column alone cannot express an append-only, multi-type ledger with its own validity window; a new table
alone cannot give the reviewer the evidence type — or the guard the enrichment outcome — without a join. So
the design uses both, with a single source of truth (the table) and clearly-labelled denormalised mirrors
(the columns), rather than duplicate authoritative copies.

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

The second mirror (§5.3's `enrichment_outcome`) is covered by the **same** pattern: the drift query gains an
arm comparing `l.enrichment_outcome` with the ledger row's `enrichment_outcome`, and the parity test C16
asserts both mirrors. Two mirrors, one discipline.

### 5.3 Compatibility with the ID-7b fail-closed enrichment guard (findings F3/F4)

**Still a proposal — nothing here is applied, and `025` stays in `database/proposals/`.**

**Context (VERIFIED in the code today).** A sibling track found that `enrichmentBlocksApproval` was
**half-inert on MariaDB**: `enrichment_outcome` has never been a column, so
`mariadb/identityLinkMariaDbRepository.js` hardcodes `enrichmentOutcome: null` (`:37`) while the fixture twin
persists it. The ID-7b fix replaced the blocklist with a frozen **allowlist**:

* `ALLOWED_ENRICHMENT_OUTCOMES = ['found']` (`domain/identityLink.js:93`);
* `enrichmentBlocksApproval(link)` refuses approval when the source is an enrichment source **and** the
  outcome is (a) **absent/blank**, (b) **present but not an allowlist member**, or (c) the confidence is
  `ambiguous`/`low` (`identityLink.js:225-241`).

For the F3 defect that is the remedy: `mapRow` returns `null` for every row on MariaDB, so arm (a) fires and
the bypass is closed. The cost is stated in the code and here: **until `025` lands, no enrichment-source link
is approvable at all** on MariaDB. That is the intended posture — approving on a value the store cannot
return is exactly the defect being fixed.

#### 5.3.1 What `025` must add (the durable fix)

`025` must make the outcome **storable and readable**, so the guard can become "the outcome must be an
allowed value" rather than "the outcome must exist". Two additions, both part of `025`:

| # | Column | Type | Why |
|---|---|---|---|
| 1 | `employee_identity_evidence.enrichment_outcome` | `ENUM(...) NULL` | the **append-only authority**: the outcome an `enrichment_corroboration` row recorded, kept with the rest of the evidence. `NOT NULL` exactly when `evidence_type='enrichment_corroboration'` (a CHECK, same style as the lookup CHECK) |
| 2 | `employee_identity_links.enrichment_outcome` | `ENUM(...) NULL` | the **guard-readable mirror**, the same pattern as `evidence_type` (invariant I2 extended). The approval path already loads this row, so the guard relaxes without adding a join. This is the column the MariaDB `mapRow`/`insertLink` must learn to persist |

```sql
-- REQUIRES THE ORCHESTRATOR TO MERGE INTO EMBEDDED APPENDIX A (that block is orchestrator-owned;
-- the author of this document was instructed not to edit it). Idempotent, information_schema-guarded,
-- exactly like the existing evidence_type column addition.
ALTER TABLE employee_identity_links
  ADD COLUMN enrichment_outcome
    ENUM('found', 'ambiguous', 'not_found', 'timeout', 'api_error', 'fallback', 'firstname_only')
    NULL DEFAULT NULL AFTER confidence;
```

The ENUM is the full vocabulary the enrichment tool can emit; the frozen `ALLOWED_ENRICHMENT_OUTCOMES` in
code is the **subset that may be approved** (`found`). Keeping the whole vocabulary storable is deliberate —
a reviewer must be able to see *why* a link is blocked — and an ENUM refuses an eighth, unknown status at the
DB, so a new outcome cannot slip in without a decision. On the fixture twin there is no ENUM, so an unknown
value *can* exist there; guard (b) refuses it. The two layers agree.

#### 5.3.2 Order of operations (exact)

1. Ingestion writes the **link first**, carrying `enrichmentOutcome` in the same insert
   (`createCandidate` → `insertLink`). The ledger row needs `link_id`, so it follows: **link → evidence**,
   never evidence-then-link.
2. `mapRow` / `insertLink` / `updateLink` in **both** repositories persist and return `enrichment_outcome` —
   this is exactly the parity item F3/F4 were about.
3. `approve(linkId)` loads the link (`findById`) and evaluates `enrichmentBlocksApproval(link)`; the outcome
   it reads is the **link mirror**. The ledger row is the record, not the read path.
4. A human approval then writes its own `operator_review` evidence row — a different `evidence_type`, so
   `uk_identity_evidence_link_type` permits it alongside the `enrichment_corroboration` row (I1).

#### 5.3.3 The transition — no window where an unapprovable link becomes approvable without new evidence

| Moment | Link whose outcome was `ambiguous` | Link whose outcome was never recorded |
|---|---|---|
| **Today** (guard shipped, column absent) | `mapRow` returns `null` ⇒ **blocked** | `null` ⇒ **blocked** |
| **`025` applied, runtime unchanged** | column exists but `mapRow` still returns `null` ⇒ **still blocked** | **still blocked** |
| **`025` applied + runtime persists the outcome** | `ambiguous` stored ⇒ guard (b) ⇒ **still blocked** | `NULL` (no back-fill) ⇒ guard (a) ⇒ **still blocked** |
| **The only path to approvable** | — | an explicit allowlisted value (`found`) written by the enrichment path ⇒ **new evidence** |

The rule that makes this hold: **`025` performs no back-fill.** Pre-existing rows keep
`enrichment_outcome = NULL`, which means "we could not establish a clean match", never "inferred as found".
Failing closed is the default *because `NULL` is not an allowlist member*. It is the same no-back-fill
stance as §5's `approved_by` and §9's `evidence_type`.

#### 5.3.4 Is "presence required" consistent with "must be an allowed value"?

Yes — they are the **same check**, not competing ones. `null`/`''` is not a member of
`ALLOWED_ENRICHMENT_OUTCOMES`, so guard (a) is a strict special case of guard (b). Nothing can pass (b) while
failing (a), and no value is lost by relaxing the wording.

Consequence worth stating plainly: **the relaxation is automatic once the value can be read — no guard change
is needed.** What must change is the *data path*: add the column and persist it in both twins. If `025` added
the column but `mapRow` were left hardcoding `null`, the guard would block **forever** — a functional
failure, and the same twin-divergence class as F3. That is why the parity test in the test plan is not
optional.

One part of the guard is deliberately **kept**: check (c), `confidence ∈ {ambiguous, low}`, stays even when
the outcome is `found`. A `found`/`low` pair is contradictory evidence and must be reviewed, not approved.

#### 5.3.5 What the shipped ID-7b test requires of this transition

`backend/tests/identityLinkEnrichment.mariadb.test.js` deliberately **pins the divergence** today: it asserts
that a link written with `enrichmentOutcome: 'found'` reads back as `null`, that approval is refused
`403 IDENTITY_REVIEW_REQUIRED`, and that `employee_identity_links.enrichment_outcome` does **not** exist. That
is by design — it fails loudly the moment `025` lands. **Activating `025` therefore includes updating that
test** (assert the round trip + the allowlist behaviour instead of the absence) and adding the column to both
twins. Recorded as an activation precondition, not as a test to delete.

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

**In this design:** the evidence table, the mirror columns, the digest-based verification, the state table,
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
  recorded", not "evidence invented after the fact". The same rule applies to `enrichment_outcome` (§5.3.3):
  a pre-`025` enrichment link keeps `NULL` and stays unapprovable, rather than being back-filled to `found`.

**Open items for the owner (feeding ADR-011 and the register):**

| # | Item | Decision needed |
|---|---|---|
| E1 | Approve migration `025` as a real migration (move out of `database/proposals/`) | owner + DBA, separate approved change |
| E2 | Retention policy for identity evidence | owner + privacy officer |
| E3 | Whether to close the session-revocation gap (§7) | owner — separate design |
| E4 | Whether the SSO direct-insert should become candidate→approve (§4.1) | owner — separate design (S-01/S-02) |
| E5 | Whether to `BUILD` the DB-level append-only trigger (§9) despite the privilege cost | DBA |
| E6 | **ID-7b durable fix** (§5.3): approve `enrichment_outcome` on `employee_identity_links` + `employee_identity_evidence` so the fail-closed guard can be relaxed to "must be an allowed value" | owner — rides the same `025` gate as E1 |

<!-- BEGIN EMBEDDED-DDL-PROPOSAL -->

## Appendix A — the migration DDL, embedded for review (PROPOSAL ONLY)

### A.1 Why the DDL is embedded here instead of committed as a file

The SQL was authored as `database/proposals/025_identity_evidence.up.sql` and `.down.sql`. Those files are
**deliberately not committed**, because two independent repository controls both reject SQL in that
location — and they agree on purpose:

| Control | Behaviour for `database/proposals/*.sql` |
|---|---|
| `.gitignore` | `*.sql` is ignored; the negations allow only `database/migrations/`, `database/seeds/`, `database/preflight/` and `database/rollbacks/` |
| `scripts/secret-scan.mjs` (`isBlockedSqlPath`) | a **tracked** `.sql` file outside those four directories fails the CI `secrets` job as a *blocked filename* |

The policy those controls implement is sound and was **not** weakened to accommodate this proposal:
unreviewed operator SQL must not be committable anywhere except the reviewed, numbered directories. So the
files stay untracked on disk, and the DDL is reproduced below verbatim so it is still reviewable in Git.

**Consequence, stated plainly:** the `.sql` files exist only on the workstation that authored them. This
appendix — not `database/proposals/` — is the durable record. Committing the files requires first moving
them into `database/migrations/` as a separate, **approved** change (see `database/proposals/README.md`).

### A.2 `025_identity_evidence.up.sql` (NOT APPLIED)

```sql
-- =============================================================================================
-- 025_identity_evidence.up.sql  —  ID-6b / S-02
--
-- PROPOSAL ONLY.  NOT IN THE MIGRATION LEDGER.  NOT APPLIED.  DO NOT EXECUTE.
--
-- This file lives in `database/proposals/`, NOT in `database/migrations/`, on purpose:
--   * `scripts/migrate.mjs` applies EVERY file in `database/migrations/` and the ledger
--     (`schema_migrations.version`) keys on the FILENAME with NO CHECKSUM and NO approval step.
--   * A file that merely LOOKS applyable is therefore a production hazard.
-- Moving this file into `database/migrations/` is a SEPARATE, APPROVED change, and the filename chosen
-- at that moment is frozen forever (ADR-008: an applied migration is never renamed).
--
-- Numbering: the highest existing migration filename is `024_monthly_summary_provenance.sql`;
--             `018_*`/`019_*` are reserved by draft PR #35; `020`-`024` are taken.  `025` is the next free
--             number and no `025_*` file exists in the tree (checked 2026-10-16).
--
-- What it adds (design: docs/IDENTITY_EVIDENCE_MODEL.md):
--   1. `employee_identity_evidence` — an append-only ledger of identity evidence items. The durable,
--      re-checkable record that a national-ID lookup matched, instead of a caller-asserted boolean.
--   2. `employee_identity_links.evidence_type` — a nullable, denormalised mirror of the evidence TYPE so a
--      reviewer does not need a join. The evidence table remains the single source of truth.
--
-- Safety
--   * NO raw national ID, no ciphertext and no key material anywhere. Evidence stores a KEYED DIGEST
--     (HMAC-SHA-256, lowercase hex), a key version, the algorithm and the lookup domain — the pattern
--     migration 015 already established for `employee_identifier.id_value`. ADR-004 / ADR-010.
--   * Additive and idempotent: the table uses IF NOT EXISTS; every change to an EXISTING table is guarded
--     by information_schema, so a rerun after a partial failure (DDL auto-commits) is safe. Limitation,
--     stated rather than implied: IF NOT EXISTS does not repair a pre-existing table that is missing one of
--     its CHECK constraints; that state cannot arise from this file alone.
--   * No existing table is altered destructively, no row is rewritten, no migration is renamed.
--   * Requires MariaDB >= 10.2.3 (enforced CHECK constraints) or MySQL >= 8.0.16 — the same floor as 015;
--     the file ABORTS before any DDL otherwise.
--
-- Row growth / retention
--   * One evidence row per approval-bearing transition; the dominant producer is an SSO first-login, i.e.
--     AT MOST ONE ROW PER DISTINCT PROVIDER SUBJECT (<= 1 per employee holding an SSO identity). With the
--     confirmed 50-person scope that is tens of rows total; growth is O(employees + grant changes), not
--     per-request. Row size ~400 B.
--   * Retention is an OWNER / PRIVACY decision (model S8): nothing here expires or deletes evidence, and it
--     holds no raw PII. `valid_until` expresses the ACCESS window, not the retention period.
--
-- Rollback: database/proposals/025_identity_evidence.down.sql   (also a proposal)
-- =============================================================================================

SET @server_version = VERSION();
SET @server_num =
    CAST(SUBSTRING_INDEX(@server_version, '.', 1) AS UNSIGNED) * 10000
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '.', 2), '.', -1) AS UNSIGNED) * 100
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '-', 1), '.', 3), '.', -1) AS UNSIGNED);
SET @server_supported = IF(
  @server_version LIKE '%MariaDB%', @server_num >= 100203, @server_num >= 80016
);
SET @ddl = IF(@server_supported,
  'SELECT 1',
  'SELECT * FROM ABORT_025_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE s0 FROM @ddl; EXECUTE s0; DEALLOCATE PREPARE s0;

-- ---------------------------------------------------------------------------------------------
-- 1. The evidence ledger
--
-- `evidence_type` is an ENUM, not free text: the same closed-set discipline that
-- `IDENTITY_LINK_SOURCES` applies in code (hardening ID-7). v1 runtime is expected to create only
-- 'sso_national_id_lookup'; 'operator_review' exists for a human approval, and
-- 'enrichment_corroboration' for the (still-gated) Person-API path.
--
-- `lookup_digest` uses utf8mb4/utf8mb4_unicode_ci to MATCH `employee_identifier.id_value`'s collation:
-- the verification query joins the two, and a different collation would risk a collation-mix error.
-- The lowercase-hex CHECK makes the case-insensitive collation harmless.
--
-- There is deliberately NO `updated_at`: an evidence row that can be edited is not evidence.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_identity_evidence (
  evidence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  evidence_type ENUM('sso_national_id_lookup', 'operator_review', 'enrichment_corroboration') NOT NULL,
  -- ID-7b / §5.3: what an enrichment_corroboration row's enrichment actually returned. The append-only
  -- AUTHORITY for the outcome. NULL means "no outcome recorded", which is NOT "found" and must never be
  -- read as success. The CHECK below requires it exactly when evidence_type is enrichment_corroboration.
  enrichment_outcome ENUM('found','ambiguous','not_found','timeout','api_error','fallback','firstname_only') NULL DEFAULT NULL,
  employee_uid VARCHAR(36) NOT NULL,
  provider_id INT(11) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  subject_type VARCHAR(64) NOT NULL DEFAULT 'opaque',
  link_id INT(11) NOT NULL,
  source VARCHAR(64) NOT NULL,
  observed_at DATETIME NOT NULL,
  observed_by VARCHAR(128) NOT NULL,
  valid_from DATE NOT NULL,
  valid_until DATE NULL DEFAULT NULL,
  approving_actor VARCHAR(128) NOT NULL,
  approval_reason VARCHAR(255) NOT NULL,
  checksum_valid TINYINT(1) NOT NULL DEFAULT 0,
  lookup_digest VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL,
  lookup_key_version SMALLINT UNSIGNED NULL DEFAULT NULL,
  digest_algorithm VARCHAR(16) NULL DEFAULT NULL,
  lookup_domain VARCHAR(64) NULL DEFAULT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (evidence_id),
  -- Idempotency (named rule): at most ONE evidence item of a given type per link. The subject-level
  -- idempotency is already enforced by employee_identity_links.uk_employee_identity_provider_subject
  -- (migration 012): one link per (provider, subject), therefore one such evidence row per subject.
  UNIQUE KEY uk_identity_evidence_link_type (link_id, evidence_type),
  -- Query: "all evidence for this employee, newest first" (reviewer, access review).
  KEY idx_identity_evidence_employee (employee_uid, observed_at),
  -- Query: "what evidence exists for this subject" (conflict / replay investigation).
  KEY idx_identity_evidence_subject (provider_id, provider_subject, observed_at),
  -- Query: the verification probe — "find evidence whose digest equals <digest> under version <v>",
  -- i.e. the evidence-side of the join in docs/IDENTITY_EVIDENCE_MODEL.md S3.3, and the
  -- cross-employee duplicate detector.
  KEY idx_identity_evidence_verify (lookup_digest, lookup_key_version),
  CONSTRAINT fk_identity_evidence_employee
    FOREIGN KEY (employee_uid) REFERENCES employees (employee_uid),
  CONSTRAINT fk_identity_evidence_provider
    FOREIGN KEY (provider_id) REFERENCES identity_providers (id),
  -- RESTRICT: an evidence ledger must not be silently orphaned by deleting its link.
  CONSTRAINT fk_identity_evidence_link
    FOREIGN KEY (link_id) REFERENCES employee_identity_links (id) ON DELETE RESTRICT,
  -- A lookup-type evidence row is only meaningful with a complete, comparable digest.
  CONSTRAINT chk_identity_evidence_lookup CHECK (
      -- and: an enrichment_corroboration row MUST carry an outcome, so the authority cannot be silent
  AND (evidence_type <> 'enrichment_corroboration' OR enrichment_outcome IS NOT NULL)
  evidence_type <> 'sso_national_id_lookup'
    OR (lookup_digest IS NOT NULL
        AND lookup_key_version IS NOT NULL
        AND digest_algorithm IS NOT NULL
        AND lookup_domain IS NOT NULL)
  ),
  -- Same shape rule as migration 015's chk_employee_identifier_national_lookup.
  CONSTRAINT chk_identity_evidence_digest_shape CHECK (
    lookup_digest IS NULL OR lookup_digest REGEXP '^[0-9a-f]{64}$'
  ),
  -- Inclusive window; NULL valid_until = unbounded (the employee_identifier.effective_to convention).
  CONSTRAINT chk_identity_evidence_window CHECK (
    valid_until IS NULL OR valid_until >= valid_from
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------------------------
-- 2. The review mirror on the link row
--
-- Nullable on purpose: NULL means "no evidence recorded" for every pre-ID-6b row. It must never be read
-- as "no evidence was required". The authoritative record is employee_identity_evidence; a MariaDB CHECK
-- cannot span two tables, so the mirror is kept honest by a single write path plus the drift query in
-- docs/IDENTITY_EVIDENCE_MODEL.md S5.2 (test C9).
-- ---------------------------------------------------------------------------------------------
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identity_links'
    AND COLUMN_NAME = 'evidence_type'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identity_links ADD COLUMN evidence_type
     ENUM(''sso_national_id_lookup'', ''operator_review'', ''enrichment_corroboration'')
     NULL DEFAULT NULL AFTER source');
PREPARE s1 FROM @ddl; EXECUTE s1; DEALLOCATE PREPARE s1;

-- 2b (ID-7b). Add the guard-read mirror: `enrichment_outcome`. Same guarded prepared-statement pattern.
--     This is the column `enrichmentBlocksApproval` reads. Without it the ambiguity guard cannot see the
--     outcome at all, which is the defect that made the control inert on MariaDB (contract findings F3/F4).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identity_links'
    AND COLUMN_NAME = 'enrichment_outcome'
);
SET @ddl = IF(@col_exists > 0, 'SELECT 1',
  'ALTER TABLE employee_identity_links ADD COLUMN enrichment_outcome
     ENUM(''found'',''ambiguous'',''not_found'',''timeout'',''api_error'',''fallback'',''firstname_only'')
     NULL DEFAULT NULL AFTER evidence_type');
PREPARE s1b FROM @ddl; EXECUTE s1b; DEALLOCATE PREPARE s1b;

-- No secondary index on evidence_type: the observed cardinality is small and the reviewer path filters by
-- employee or link first. Adding one would be speculative; revisit only with a query that needs it.

-- ---------------------------------------------------------------------------------------------
-- 3. Additive-only guarantee (documented, not enforced)
--
-- `employee_identity_links.approved_by` is NOT touched, renamed or back-filled, so the existing value
-- 'system:sso' keeps its exact meaning (docs/IDENTITY_EVIDENCE_MODEL.md S4.2). `employee_identifier` and
-- `identity_providers` are NOT modified: the comparison target already exists as
-- employee_identifier.id_value + lookup_key_version, and adding a pointer would duplicate a digest that is
-- already stored.
--
-- NOTE for the activation phase: `mariadb/identityLinkMariaDbRepository.js` SELECTs columns by name (not
-- `SELECT *`), so this ADD COLUMN does not break it; `insertLink` does not pass `evidence_type`, so it stays
-- NULL until the runtime write path is implemented (out of scope for this proposal).
-- ---------------------------------------------------------------------------------------------
```

### A.3 `025_identity_evidence.down.sql` (rollback; NOT APPLIED)

```sql
-- =============================================================================================
-- 025_identity_evidence.down.sql  —  ID-6b / S-02
--
-- PROPOSAL ONLY.  NOT IN THE MIGRATION LEDGER.  NOT APPLIED.  DO NOT EXECUTE.
--
-- Reverses database/proposals/025_identity_evidence.up.sql.
--
-- WARNING — DATA LOSS
--   This drops `employee_identity_evidence` in full. The evidence ledger is the ONLY durable record that a
--   given approval rests on a matched national-ID lookup; the digest can NOT be reconstructed from the link
--   row, and the raw identifier is deliberately not stored anywhere. A rollback therefore makes every
--   approval UNVERIFIABLE again. If the rows matter, export them first:
--     SELECT * FROM employee_identity_evidence;
--   Link rows themselves are not deleted: only the nullable mirror column is dropped.
--
-- Idempotent: safe to run when part of the change was already reversed.
-- =============================================================================================

SET @server_version = VERSION();
SET @server_num =
    CAST(SUBSTRING_INDEX(@server_version, '.', 1) AS UNSIGNED) * 10000
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '.', 2), '.', -1) AS UNSIGNED) * 100
  + CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(@server_version, '-', 1), '.', 3), '.', -1) AS UNSIGNED);
SET @server_supported = IF(
  @server_version LIKE '%MariaDB%', @server_num >= 100203, @server_num >= 80016
);
SET @ddl = IF(@server_supported,
  'SELECT 1',
  'SELECT * FROM ABORT_025_down_requires_MariaDB_10_2_3_or_MySQL_8_0_16');
PREPARE r0 FROM @ddl; EXECUTE r0; DEALLOCATE PREPARE r0;

-- 1. Drop the mirror column (guarded; the column is NULL for every pre-ID-6b row, so no data is lost for
--    links that never had evidence).
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identity_links'
    AND COLUMN_NAME = 'enrichment_outcome'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identity_links DROP COLUMN enrichment_outcome');
PREPARE r1 FROM @ddl; EXECUTE r1; DEALLOCATE PREPARE r1;

-- 1b. Then the evidence_type mirror, with its OWN guard, so the file stays idempotent when only one of
--     the two columns was ever applied.
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_identity_links'
    AND COLUMN_NAME = 'evidence_type'
);
SET @ddl = IF(@col_exists = 0, 'SELECT 1',
  'ALTER TABLE employee_identity_links DROP COLUMN evidence_type');
PREPARE r1b FROM @ddl; EXECUTE r1b; DEALLOCATE PREPARE r1b;

-- 2. Drop the evidence ledger. Its FKs (to employees / identity_providers / employee_identity_links) go with
--    it, including the ON DELETE RESTRICT guard on the link.
DROP TABLE IF EXISTS employee_identity_evidence;
```

<!-- END EMBEDDED-DDL-PROPOSAL -->
