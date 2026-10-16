# Identity evidence — threat model (ID-6b / S-02)

**Status:** `DESIGN — PROPOSED, NOT APPROVED`. **Nothing executed.**
**Date:** 2026-10-16 · **Companion:** [`../IDENTITY_EVIDENCE_MODEL.md`](../IDENTITY_EVIDENCE_MODEL.md),
[`IDENTITY_EVIDENCE_TEST_PLAN.md`](IDENTITY_EVIDENCE_TEST_PLAN.md), [`../adr/ADR-011-identity-evidence-storage.md`](../adr/ADR-011-identity-evidence-storage.md)

**Labels.** **VERIFIED** = the behaviour was read in this repository's code or schema today (a file is cited).
**ASSESSED** = reasoned from the design; not observed running. A threat whose mitigation rests on an
**ASSESSED** claim is called out in the Residual risk column.

**Scope.** Attacks on *identity-evidence storage and approval provenance* for the SSO/identity path. Out of
scope: attendance-data integrity, the HIP ingestion path, the frontend, and the physical/host layer (covered
elsewhere).

---

## 1. Summary

| # | Threat | Verdict on the design |
|---|---|---|
| T1 | Replay of a captured provider subject | Mitigated by the subject-unique key; residual = token/session layer, not evidence |
| T2 | Tampering with a *declared* evidence flag | **Mitigated by construction** — the flag is no longer the proof |
| T3 | Forged evidence by a compromised internal caller | **Partially mitigated** — the strongest residual risk, needs DB privilege separation |
| T4 | Concurrency / duplicate approval | Mitigated by unique keys; residual = an ugly 500, not a duplicate row |
| T5 | Cross-employee approval (subject onto another employee) | Mitigated by the subject-unique key + employee-bound digest check |
| T6 | Revocation arriving too late | **Known gap, not closed** — stateless access token + refresh not re-checked |
| T7 | Evidence outliving employment | **Unmitigated** — no retention mechanism exists |
| T8 | Baseline: the CURRENT unverifiable boolean | **Confirmed present today** (VERIFIED); this design is the mitigation |

---

## 2. Threat table

### T1 — Replay of a subject

| Field | Detail |
|---|---|
| **Threat** | An attacker captures a valid provider subject (a token, a log line, a shared URL) and replays it to mint or reuse an identity link. |
| **Mitigation in this design** | The evidence row binds the subject to a **provider**, to one **employee**, and to a **digest verified at login**. A replayed subject whose national-id lookup does not resolve to the same employee cannot produce a matching digest, so the recorded evidence **fails verification** (§3 of the model). The link's `uk_employee_identity_provider_subject` also prevents minting a *second* link for the subject. |
| **Residual risk** | Evidence records *what was presented*; it cannot detect that a legitimate subject token was replayed by someone else. That is the provider's anti-replay contract (nonce/`ac` semantics — ADR-D10, **UNKNOWN**), not something this table can fix. |
| **Detectable by a test?** | **Yes** — replay the same subject with a *different* employee's digest expectation; the verification query must return 0 rows and a link must not be created. Non-vacuity: the positive variant (same subject + matching digest) must pass. |
| **Label** | Mitigation **VERIFIED** for the constraint (`uk_employee_identity_provider_subject`, migration 012); the digest-binding half is **ASSESSED** until 025 is applied. |

### T2 — Tampering with a declared evidence flag

| Field | Detail |
|---|---|
| **Threat** | The current design's core failure: `evidence.nationalIdLookupMatched === true` is a **caller assertion**. A caller (or a bug) sets it without any lookup; the link is approved and looks normal. |
| **Mitigation in this design** | The boolean is **demoted to descriptive**. The verifiable fact is `lookup_digest` + `lookup_key_version` + algorithm/domain, checked for **equality against the employee's own `employee_identifier` row**. Flipping `checksum_valid` or any descriptive flag does not change the verification outcome, because verification does not read it. A `CHECK` also refuses `evidence_type='sso_national_id_lookup'` with a missing/partial digest. |
| **Residual risk** | None for *tampering with a flag* — the flag carries no authority. (Forgeing the *digest* is T3, a different threat.) |
| **Detectable by a test?** | **Yes** — set `checksum_valid=0`/`1` and re-run verification; the verdict must be unchanged. A second test must show the **model's own** positive is not vacuous: assert the digest-equal case *is* verified. |
| **Label** | Mitigation **ASSESSED** (depends on the CHECK + verification query, both unapplied). |

### T3 — Forged evidence by a compromised internal caller

| Field | Detail |
|---|---|
| **Threat** | An actor with the application's DB credentials (or an insider) writes an evidence row whose `lookup_digest` they copied from a **victim's** `employee_identifier` row, binding their own `provider_subject` to the victim's `employee_uid`. The equality query then passes. |
| **Mitigation in this design** | (a) The digest cannot be *computed* without the HMAC key — an attacker who can only read `employee_identifier` must still **copy** a digest, which only works if they also control the evidence row and the link row. (b) The design pushes the store toward least privilege: the app role needs `INSERT` on the evidence table and should **not** have `UPDATE`/`DELETE`; the append-only shape (no `updated_at`, FK `ON DELETE RESTRICT`) exists to make that grant natural. (c) `observed_by` + `approving_actor` + `created_at` give an audit trail to correlate. |
| **Residual risk** | **The largest residual risk in this design.** Equality over stored data is not proof that the *lookup happened*; a fully privileged writer can construct a consistent forgery. Mitigating it properly needs DB-role separation and/or an append-only trigger (deferred, R3 in the model) and out-of-band audit — none of which are in this proposal. Stated, not hidden. |
| **Detectable by a test?** | **Partially.** A test can prove the *detection* half: a digest bound to a different employee must fail, a hand-written evidence row with a fabricated digest must fail, and a copied-digest row whose `employee_uid` disagrees must be caught by the cross-employee query. A test **cannot** prove the store is immutable — that is the deferred trigger. The test plan records this boundary explicitly. |
| **Label** | Design intent **ASSESSED**; the privilege separation is **REPORTED** (not implemented here). |

### T4 — Concurrency / duplicate approval

| Field | Detail |
|---|---|
| **Threat** | Two simultaneous first-logins (or two reviewer clicks) create two approved links / two evidence rows for one identity. |
| **Mitigation in this design** | Named constraints: `uk_employee_identity_provider_subject (provider_id, provider_subject)` (exists, migration 012) → at most one link per subject **ever**; `uk_identity_evidence_link_type (link_id, evidence_type)` (new) → at most one evidence item of a type per link. The application's `findApprovedForEmployee` pre-check is a read, not a lock, and must not be relied on. |
| **Residual risk** | The **loser fails with `ER_DUP_ENTRY` surfaced as a 500** instead of an idempotent re-read — an availability/UX defect, not an integrity one. No duplicate row is ever created. Fixing the 500 is activation-phase code. |
| **Detectable by a test?** | **Yes** — a MariaDB-only concurrency test that issues two link inserts and asserts exactly one row exists and the second fails on the unique key. A fixture twin **cannot** test this (no real constraints) — see the test plan's twin caveat. |
| **Label** | **VERIFIED** (the constraint exists in migration 012; the 500 path is **ASSESSED** from the absence of duplicate-key handling in `identityResolutionService`). |

### T5 — Cross-employee approval (one subject approved onto another employee)

| Field | Detail |
|---|---|
| **Threat** | A subject is linked to employee A but approved, or re-pointed, onto employee B — either maliciously or by a bad match. |
| **Mitigation in this design** | Three layers: (a) `findByProviderSubject` + `IDENTITY_SUBJECT_CONFLICT` (409) refuses to reuse a subject for another employee (**VERIFIED**, `linkProviderSubjectFromSsoLogin`); (b) the subject-unique key refuses it at the DB even if the code is bypassed; (c) the evidence row stores `employee_uid` and the verification query requires the digest to resolve to **that** employee, with a cross-employee variant that must return nothing. |
| **Residual risk** | A stale/incorrect upstream binding (audit **F3**: plaintext ids at rest in a non-git directory; **F5**: one id seen under two names) can make the *root* wrong, and this table will faithfully record evidence for the wrong person. Evidence cannot be stronger than its source. |
| **Detectable by a test?** | **Yes** — attempt to link subject S to employee B while it is approved for A: must be `409`; and the cross-employee digest query must return 0 rows. |
| **Label** | (a) **VERIFIED**; (b) **VERIFIED** (constraint exists); (c) **ASSESSED** (query unapplied). |

### T6 — Revocation that arrives too late

| Field | Detail |
|---|---|
| **Threat** | Evidence is revoked (or expires), but the attacker keeps a working session. |
| **Mitigation in this design** | The link moves to `revoked` and `resolve()` refuses **new** sessions (`IDENTITY_NOT_APPROVED`, **VERIFIED**). The evidence row records the close of the validity window. |
| **Residual risk** | **Known gap.** An already-issued **access token is a stateless JWT** and stays valid until `exp`; a **refresh token is not re-checked against the link** — `authService.refresh` validates only the token row (**VERIFIED**, `authService.js:95-123`). So revocation is "no *new* sessions", not "no session". Expiry is even weaker: it is currently **evaluated nowhere** (the link read path does not consult a window). |
| **Detectable by a test?** | **Yes**, as a behavioural pin: after revoking a link, the *existing* access token must still be accepted (documents current behaviour) **and** a fresh `resolve()` must be refused. If someone later closes the gap, the first assertion fails loudly rather than silently changing security posture. |
| **Label** | **VERIFIED** (both code paths read today). |

### T7 — The evidence row outliving the person's employment

| Field | Detail |
|---|---|
| **Threat** | The evidence row (and the digest linkage to a real person) persists indefinitely after the employee leaves, becoming a long-lived re-identification aid and a retention/compliance liability. |
| **Mitigation in this design** | The row stores **no raw PII** — a keyed digest, a provider subject (a provider-side opaque token), and metadata — so the re-identification value is bounded by the HMAC key. `valid_until` records when the *access* window closes. The FK `ON DELETE RESTRICT` keeps evidence from vanishing silently. |
| **Residual risk** | **Unmitigated.** Nothing expires or deletes the evidence row; no retention job exists; employment end is not an event this schema observes. A digest is still a stable per-person pseudonym as long as the HMAC key is not destroyed, so "key destroyed ⇒ evidence no longer comparable" is the only real erasure mechanism and it is not designed here. Needs an owner/privacy decision (model §8, E2). |
| **Detectable by a test?** | **No** — retention is a process control; a test can only assert that no automatic deletion exists (which is what it would pin). Honest: this is a policy gap, not a test gap. |
| **Label** | **ASSESSED**. |

### T8 — The CURRENT design's unverifiable boolean (baseline)

| Field | Detail |
|---|---|
| **Threat / defect** | Today an APPROVED link can be created by any caller that sets `evidence: { nationalIdLookupMatched: true }`; the declaration is never stored, so it cannot be re-checked. `approvedBy: 'system:sso'` and `source` describe the actor and a claimed method, not the matched value. |
| **Evidence** | **VERIFIED** — `identityResolutionService.js:296-301` (the check), `:329-340` (the approved insert), and the file's own comment at `:288-295` ("this assertion is NOT independently verifiable here … the durable fix is a dedicated evidence column … still open (S-02)"). |
| **Mitigation in this design** | Store the keyed digest + key version + algorithm/domain on an append-only evidence row and verify it by equality against the employee's own `national_id` row (§3 of the model). |
| **Residual risk** | The mitigation is only real once 025 is applied **and** the runtime writes the digest at the point of lookup — both are out of scope for this design track. Until then the gap is open. |
| **Detectable by a test?** | **Yes** — the baseline assertion is "a link approved with only a declared flag has no verifiable evidence", which must flip to "verified" only when a matching digest is present. |
| **Label** | **VERIFIED**. |

---

## 3. Trust boundaries

```
        untrusted                boundary                    trusted for verification
  ┌──────────────────┐   ┌────────────────────┐   ┌──────────────────────────────────┐
  │ caller-supplied  │   │ identityResolution │   │ employee_identifier (national_id)│
  │ subject + boolean│──▶│ .resolve() lookup  │──▶│  = digest + key_version          │
  │  evidence flag   │   │ (has the raw id →  │   │  ── the ONLY comparison target ──│
  └──────────────────┘   │  digest)           │   └──────────────────────────────────┘
        NO authority     └────────┬───────────┘                 ▲
                                  │ stores                      │ equality proof
                                  ▼                             │
                      ┌────────────────────────────┐            │
                      │ employee_identity_evidence │────────────┘
                      │ (append-only, digest only) │
                      └────────────────────────────┘
                                  ▲
                       authority is here, not in the caller
```

The **raw national ID never enters the evidence table or the link table** — only the digest does. The caller's
boolean is outside the digest path entirely, which is what makes T2 a non-threat.

---

## 4. What this design does not claim

* It does **not** claim revocation invalidates live sessions (T6).
* It does **not** claim the evidence store is immutable (T3) — that needs a DB role/trigger decision.
* It does **not** claim the digest proves a person's *real* citizen id, only that the value matched V2's own
  binding (T5, model §3.4).
* It does **not** claim retention is handled (T7).
* It does **not** claim any of this is active: the SQL lives in `database/proposals/` and is **not in the
  migration ledger** and **not applied**.
