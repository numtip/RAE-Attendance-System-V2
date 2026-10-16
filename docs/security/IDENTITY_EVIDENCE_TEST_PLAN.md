# Identity evidence — adversarial test plan (ID-6b / S-02)

**Status:** `DESIGN — PROPOSED, NOT APPROVED`. **No test in this document exists yet.** It specifies the tests
that must accompany the activation of [`../IDENTITY_EVIDENCE_MODEL.md`](../IDENTITY_EVIDENCE_MODEL.md), and the
mutations that must make each of them fail.
**Date:** 2026-10-16 · **Companions:** [`IDENTITY_EVIDENCE_THREAT_MODEL.md`](IDENTITY_EVIDENCE_THREAT_MODEL.md),
[`../adr/ADR-011-identity-evidence-storage.md`](../adr/ADR-011-identity-evidence-storage.md)

**Baseline today (do not regress):** `backend` suite **508 tests · 498 pass · 0 fail · 10 skipped**;
`npm run lint` PASS; `nationalIdFixtureHygiene` guard PASS. A sibling track is editing other files
concurrently, so a failure in a file this track does not own is reported, not "fixed".

---

## 1. House rules this plan obeys

These are not optional style notes; each has bitten this repository already (`docs/memory/NEXT_ACTIONS.md` §7).

| Rule | Why it is in this plan |
|---|---|
| **R1 — a guard must prove it is not vacuous** | Rule 7.10: two checks in this repo "verified" nothing because they read 0 files / matched 0 literals. Every guard test here asserts its own **coverage** (rows read, matches found) and is **mutation-tested**. |
| **R2 — mutation testing is the evidence standard** | Rule 7.10, and the contract's §4.1. "A guard whose removal changes nothing is decoration." Every control below names the mutation that must kill it. |
| **R3 — synthetic, checksum-INVALID fixtures only** | `docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`. A checksum-valid 13-digit literal must **never** be committed; where a valid value is genuinely needed, **derive it at runtime** (the pattern `backend/tests/nationalIdContract.test.js` already uses). The CI guard `nationalIdFixtureHygiene.test.js` canonicalizes before checking, so an alternately-encoded literal is also caught. |
| **R4 — the fixture/MariaDB twin hides type divergence** | Rule 7.6: local green is necessary, not sufficient. Every constraint test below is marked **DB-ONLY** where a fixture twin cannot enforce it. |
| **R5 — an `await` is part of an authorization check** | Rule 7.3. Any test that asserts a refusal must also assert **no row was written**, not just that a rejection was thrown. |
| **R6 — no `String(value).slice(0,10)` on a stored date** | Rule 7.1. The expiry tests use `wallDateOnly()`. |

---

## 2. Fixture set (all synthetic)

| Fixture | Shape | Notes |
|---|---|---|
| `SYNTH_ID_INVALID` | the repository's existing **checksum-invalid** synthetic (masked `****0002`) | Already used by the post-incident fixtures. Canonicalizable (13 digits) but fails the Thai checksum — which is exactly what R3 requires. Do not copy the literal from any doc; import the shared fixture |
| `SYNTH_ID_VALID_RUNTIME` | a checksum-**valid** value **derived at test runtime** from an impossible prefix | Only where the checksum itself is under test. Never a committed literal |
| `EMP_A`, `EMP_B` | two distinct `employee_uid` values | Synthetic UUIDs |
| `SUBJ_OPAQUE` | an opaque provider subject (not an e-mail, not `ac`) | e.g. a provider-shaped opaque token |
| `KEY_V1`, `KEY_V2` | two distinct base64 HMAC keys, `EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION=1` / `=2` | Test-local env only; never a real key |
| `DIGEST_A@v1` | `identifierLookupHmac('national_id', SYNTH_ID_INVALID, KEY_V1)` | Computed in-test with the production function — never hard-coded |

All fixtures live under `backend/tests/fixtures/` and are built **with** `nationalIdContract.js`, so a change
to the domain function moves the fixture with it (no drifting literal).

---

## 3. Test matrix

Legend: **U** = unit/domain, **S** = service, **DB** = requires MariaDB (the `backend-mariadb` CI job).

### C1 — A declared boolean is not evidence

| | |
|---|---|
| **Control** | T2/T8: the flag carries no authority |
| **Exact test** | Approve a link through the current path with `evidence:{ nationalIdLookupMatched:true }` and **no** evidence row. Assert (a) the link is approved, (b) the verification query in model §3.3 returns **0 rows** ⇒ the claim is **UNVERIFIED**. Then insert the evidence row with `lookup_digest = DIGEST_A@v1` and assert the same query returns **1 row** ⇒ VERIFIED. |
| **Fixture** | `EMP_A`, `SUBJ_OPAQUE`, `DIGEST_A@v1` |
| **Mutation that must fail the test** | Make the verification query return a row when the digest is absent (e.g. `LEFT JOIN` + `COALESCE(... , 1)`) → the "0 rows" assertion fails. |
| **Non-vacuity** | Assert both directions (0 then 1) **in the same test**; a query that always returns 1 or always 0 fails one half. |
| **Level** | S + DB (the join needs real tables; a fixture twin can fake it but cannot prove the constraint) |
| **Label** | **ASSESSED** — needs 025 applied |

### C2 — Tampering with a descriptive flag changes nothing

| | |
|---|---|
| **Control** | T2 |
| **Exact test** | With a valid evidence row, flip `checksum_valid` between `0` and `1` and set `approval_reason` to a different non-PII token. Run verification both times. Assert the verdict is **identical**. Separately assert that a write that *removes* `lookup_key_version` is **refused by the DB** (`chk_identity_evidence_lookup`). |
| **Fixture** | `EMP_A`, `SUBJ_OPAQUE`, `DIGEST_A@v1` |
| **Mutation** | Remove the `chk_identity_evidence_lookup` constraint from the DDL → the "refused" half fails. Change verification to read `checksum_valid` → the "identical verdict" half fails. |
| **Level** | DB (constraint) + S |
| **Label** | **ASSESSED** |

### C3 — The digest is an equality oracle, not a plaintext archive

| | |
|---|---|
| **Control** | Model §3.2: no plaintext, no recovery |
| **Exact test** | Assert `lookup_digest` is 64 lowercase hex; assert it does **not** contain the canonical id as a substring; assert `buildLookup('national_id', SYNTH_ID_INVALID, KEY_V1)` is stable across calls; assert the digest **differs** under `KEY_V2`; assert a masked value (`maskNationalId(...)` output) is **not** canonicalizable and cannot produce a digest (fails `IDENTIFIER`-class error, matching the contract's B.2 probe). |
| **Fixture** | `SYNTH_ID_INVALID`, `KEY_V1`, `KEY_V2` |
| **Mutation** | Replace HMAC with a plain SHA-256 → the "differs under KEY_V2" assertion fails (this is the same mutation class the existing contract probe already kills). |
| **Level** | U |
| **Label** | **VERIFIED** (the underlying behaviours exist today and are already probed) |

### C4 — Verification fails closed

| | |
|---|---|
| **Control** | T3/T5: a wrong or fabricated digest must not verify |
| **Exact test** | Four negative cases, each asserting **0 rows**: (a) digest present but `lookup_key_version` mismatched; (b) digest is a correct-looking but **fabricated** 64-hex value; (c) digest copied from **another employee's** binding (and the cross-employee variant of the query returns 1 row ⇒ the forgery is *detectable*); (d) `evidence_type='operator_review'` with a NULL digest queried as if it were a lookup. Plus the positive control: the matching pair returns 1 row. |
| **Fixture** | `EMP_A`, `EMP_B`, `DIGEST_A@v1`, a fabricated hex string |
| **Mutation** | Drop `i.lookup_key_version = e.lookup_key_version` from the query → case (a) starts passing → test fails. Drop the `employee_uid` join condition → cases (c)/(the cross-employee check) pass → test fails. |
| **Non-vacuity** | The positive control is mandatory; without it a query hard-wired to 0 rows would pass all four negatives. |
| **Level** | DB |
| **Label** | **ASSESSED** |

### C5 — Idempotency: a replayed first-login creates nothing new

| | |
|---|---|
| **Control** | Model §6.2 |
| **Exact test** | Call the first-login link path twice with identical input (`EMP_A`, `SUBJ_OPAQUE`, matching lookup). Assert: exactly **1** link row, exactly **1** evidence row of type `sso_national_id_lookup`, identical `evidence_id` in both returns. Then call with the **same subject and a different employee** and assert `409 IDENTITY_SUBJECT_CONFLICT` and that **no new row** was written (R5). |
| **Fixture** | `EMP_A`, `EMP_B`, `SUBJ_OPAQUE`, `DIGEST_A@v1` |
| **Mutation** | Remove the `existing` short-circuit in `linkProviderSubjectFromSsoLogin` → the second call throws `ER_DUP_ENTRY`/creates a row → the "exactly 1" assertion fails (the DB constraint still prevents 2, which is the point: the *test* catches the code regression). |
| **Level** | S + DB |
| **Label** | **VERIFIED** for the subject-unique key (exists today); the evidence half is **ASSESSED** |

### C6 — Concurrency: the race, and its exact outcome

| | |
|---|---|
| **Control** | T4 |
| **Exact test** | Two concurrent inserts of the same `(provider_id, provider_subject)` (two connections, real DB). Assert: exactly **1** row exists; the losing statement fails with a **unique-key violation**; **no** second approved link and **no** second evidence row exist. Record (do not assert as correct) whether the loser surfaces as a 500 — the test documents the current failure mode so a future idempotent-retry fix is a deliberate change. |
| **Fixture** | `EMP_A`-only; `SUBJ_OPAQUE` |
| **Mutation** | Drop `uk_employee_identity_provider_subject` → two rows appear → test fails. |
| **Level** | **DB-ONLY.** A fixture twin holds objects in an array and cannot enforce a constraint — this test is meaningless without MariaDB (Rule R4). |
| **Label** | **VERIFIED** (constraint exists in migration 012) |

### C7 — Concurrency: duplicate evidence of one type

| | |
|---|---|
| **Control** | Model §4 I1, §6.1 |
| **Exact test** | Insert two `sso_national_id_lookup` evidence rows for the same `link_id`. Assert the second fails on `uk_identity_evidence_link_type`. Then insert an `operator_review` row for the same link and assert it **succeeds** (the key is per-type, not per-link — the non-vacuity half). |
| **Fixture** | one link, two evidence rows |
| **Mutation** | Make the unique key `(link_id)` only → the `operator_review` success half fails. Remove the key → the first half fails. |
| **Level** | **DB-ONLY** |
| **Label** | **ASSESSED** |

### C8 — Constraint hygiene: the DDL refuses a partially-written lookup

| | |
|---|---|
| **Control** | Model §3.5, §2 |
| **Exact test** | Attempt inserts that must each be **rejected**: type `sso_national_id_lookup` with NULL digest; with NULL `lookup_key_version`; with a 63-char or non-hex digest; `valid_until < valid_from`. Then assert the valid row inserts. |
| **Fixture** | `EMP_A`, `SUBJ_OPAQUE`, `DIGEST_A@v1` |
| **Mutation** | Remove `chk_identity_evidence_digest_shape` → the 63-char case inserts → test fails. Same for each CHECK. |
| **Level** | **DB-ONLY** |
| **Label** | **ASSESSED** |

### C9 — The mirror cannot drift unnoticed

| | |
|---|---|
| **Control** | Model §5.2, invariant I2 |
| **Exact test** | Write a link with `evidence_type` set and **no** matching evidence row; run the drift query (model §5.2) and assert it returns **exactly that link** (non-vacuity: with a consistent pair it returns 0 rows, which must also be asserted). |
| **Fixture** | one consistent pair + one deliberately inconsistent link |
| **Mutation** | Make the drift query `SELECT … WHERE 1=0`-equivalent (e.g. drop the `e.evidence_id IS NULL` term) → the inconsistent link stops being reported → the "exactly that link" assertion fails. |
| **Level** | DB |
| **Label** | **ASSESSED** — this test is the *only* enforcement of I2 (no cross-table CHECK exists), so it must carry a non-vacuity assertion |

### C10 — Revocation / expiry vs issued sessions (behavioural pin)

| | |
|---|---|
| **Control** | T6 / model §7 |
| **Exact test** | Issue a session for `EMP_A`; revoke the link; then assert **(a)** a fresh `identityResolution.resolve()` is refused `IDENTITY_NOT_APPROVED`, and **(b)** the **already-issued access token still verifies** and **(c)** `authService.refresh(existingRefreshToken)` **still succeeds**. (b)/(c) are asserted as **current, documented behaviour**, each with a comment naming it a known gap, so closing the gap later fails loudly instead of silently changing posture. |
| **Fixture** | `EMP_A` + a session |
| **Mutation** | (Positive) Change `resolve()` to allow a revoked link → (a) fails. (Documentation) If someone adds a link check to `refresh`, (c) fails and the gap must be re-decided, not silently updated. |
| **Level** | S (fixture) |
| **Label** | **VERIFIED** |

### C11 — Expiry evaluation is fail-closed **where implemented**

| | |
|---|---|
| **Control** | Model §4.3 |
| **Exact test** | With `valid_until` set in the past on the evidence row, assert the (not-yet-written) expiry-aware read path treats the approval as **stale**; with `valid_until = NULL` assert it is treated as **unbounded** (the `employee_identifier.effective_to` convention). Assert the comparison uses `wallDateOnly()`, with a fixture whose stored value is a `Date` object (MariaDB) **and** a string (fixture twin) to catch type divergence (Rule R6 / R4). |
| **Fixture** | one expired, one unbounded evidence row |
| **Mutation** | Replace `wallDateOnly()` with `String(value).slice(0,10)` → the `Date`-object fixture fails. |
| **Level** | U + DB |
| **Label** | **ASSESSED** — the read path itself is out of scope for this design track and must be written with this test |

### C12 — PII hygiene of everything this change introduces

| | |
|---|---|
| **Control** | R3; incident remediation |
| **Exact test** | (a) Re-run `nationalIdFixtureHygiene.test.js` and assert it read **>100 files** (non-vacuity) and fails on a deliberately injected checksum-valid literal. (b) A new guard: scan `database/proposals/025_identity_evidence.up.sql` and this document for any **canonicalizable** 13-digit literal that passes the checksum → must find **0**. (c) Assert the evidence table's column list contains **no** raw-id-shaped column name (`citizen_id`, `national_id`, `id_value`). |
| **Fixture** | the proposal SQL + the docs |
| **Mutation** | Insert a checksum-valid literal into the proposal → (b) fails. Add a `national_id` column to the DDL → (c) fails. |
| **Non-vacuity** | (b) must assert it actually read the file (byte/line count > 0); a regex over a missing file would otherwise "pass" (Rule R1). |
| **Level** | U (pure file scan) |
| **Label** | **VERIFIED** (the existing hygiene guard is real; the new scan must be written) |

---

## 4. Mutation schedule (what "done" means)

A control is **done** only when every mutation below is **KILLED** (at least one test fails) and reverting the
mutation returns the suite green:

| # | Mutation | Expected kills |
|---|---|---|
| M1 | Remove `uk_employee_identity_provider_subject` from the DDL | C6 |
| M2 | Remove `uk_identity_evidence_link_type` | C7 |
| M3 | Remove `chk_identity_evidence_lookup` | C2, C8 |
| M4 | Remove `chk_identity_evidence_digest_shape` | C8 |
| M5 | Drop the `lookup_key_version` term from the verification query | C4(a) |
| M6 | Drop the `employee_uid` term from the verification query | C4(c) |
| M7 | Remove the `existing` short-circuit in `linkProviderSubjectFromSsoLogin` | C5 |
| M8 | Substitute plain SHA-256 for the keyed HMAC | C3 |
| M9 | Make the drift query ignore inconsistent rows | C9 |
| M10 | Replace `wallDateOnly()` with `String().slice(0,10)` | C11 |
| M11 | Make the doc/SQL PII scan read 0 files or 0 matches | C12(b) |

**Passing is not the deliverable.** A check whose removal changes nothing is decoration (Rule R2); the schedule
above is the acceptance criterion.

---

## 5. Not testable here (stated, not implied)

| Gap | Why a test cannot close it | Where it is recorded |
|---|---|---|
| **Append-only immutability** | No trigger is proposed (it needs `SUPER`/`log_bin_trust_function_creators`, migration 017 §20-21). A test can prove a *forgery is detectable*, not that the store is immutable | Threat T3, model §9 |
| **Retention / evidence outliving employment** | A process control, not a code path | Threat T7, model §8/E2 |
| **Whether the lookup "really happened"** | Digest equality is proof over the *store*; the event itself is not observable from the row | Model §3.4, Threat T3 |
| **Whether a real citizen id was genuine** | Root of trust is whatever wrote `employee_identifier` (audit F3) | Threat T5 |
| **The live/production DDL** | Applied nowhere; CI proves a fresh DB only | Model §9, migration graph §6 |
