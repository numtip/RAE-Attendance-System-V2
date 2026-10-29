# National ID protection policy — what is enforced, what is pending, what is undecided

**Status:** written 2026-10-29 to close a dangling reference. `database/migrations/015_employee_identifier_secure_lookup.sql`
has cited `docs/NATIONAL_ID_PROTECTION_POLICY.md` since it landed (#61), and the file did not exist.
Nothing here is new policy: it records what the schema and code already enforce, what a pending pull
request would add, and which decisions are still the owner's.

**Related:** migration `015_employee_identifier_secure_lookup.sql` + its preflight/rollback,
[`adr/ADR-013`](adr/ADR-013-migration-order-is-a-dependency.md),
`docs/memory/DECISIONS.md` (D-2026-10-21-06), PR **#60** (digest storage, open for owner review),
`docs/SECURITY_INCIDENT_PII_IN_FIXTURES_20261016.md`.

---

## 1. Enforced on `main` today

| Rule | How it is enforced | Verified by |
|---|---|---|
| A `national_id` row holds a **64-hex HMAC digest**, never a plaintext ID | `CHECK (id_type <> 'national_id' OR (lookup_key_version IS NOT NULL AND id_value REGEXP '^[0-9a-f]{64}$'))` in migration 015 | migration applies on MariaDB 11.4 in CI; the CHECK aborts **before** any DDL on a server that ignores `CHECK` (MariaDB < 10.2.3 / MySQL < 8.0.16) |
| `id_type` cannot be smuggled past the check by casing | the column is an **ENUM**, so there is no free-text value to case-fold | schema, migration 013/015 |
| The digest records **which key version** produced it | `lookup_key_version SMALLINT UNSIGNED NULL`, required for national IDs | as above |
| At most one national-ID row per employee | `UNIQUE KEY uk_employee_identifier_national_owner (national_id_owner_uid)` | migration 015 |
| Raw-ID storage is **off by default** | `employee_identifier_secret` stays empty unless a documented necessity is approved; the rollback refuses if it holds rows | migration 015 + its rollback header |
| No real national ID in the repository | a checksum-valid 13-digit literal is treated as a real person's ID | `scripts/secret-scan.mjs` in CI, plus PR #44/#77 removing one real value and one republished copy |
| A migration rolled back is removed from the ledger | every `database/rollbacks/*.down.sql` clears its own row | `backend/tests/rollbackLedger.test.js` |

## 2. Pending in PR #60 — **not on `main`, not merged**

Described here so a reader does not mistake the intent for the current behaviour:

- HMAC-SHA-256 with a **versioned key ring** (`NATIONAL_ID_HMAC_KEYS`, ≥32-byte keys), never a bare
  SHA-256; a missing, empty or weak key yields a `null` protector and a `503`, with no plaintext or
  unkeyed fallback.
- `timingSafeEqual` on two validated 64-hex buffers for digest comparison.
- `lookup_key_version` written on insert; every accepted version tried on lookup.
- A `national_id` row returns `idValueMasked: null` — there is no meaningful mask of a digest.
- A fixture-hygiene test that fails if any checksum-valid 13-digit literal is committed anywhere,
  including `database/`.

Until #60 merges, `national_id` identifiers are **not** written as digests by the application; the
schema supports it and the application side is what changes.

## 3. Open owner decisions

| # | Decision | Why it matters |
|---|---|---|
| **N-1** | **Retention**: how long a digest (and the key version that produced it) is kept, and what the lawful basis is for holding it at all | a digest is still personal data when the key exists; migration `C-14`/contract `C-14` in the SSO standard marks the lawful-basis question `BLOCKED` |
| **N-2** | **Rotation**: is dropping an old key version ever allowed? | dropping one silently orphans every row under it — those employees become unresolvable, and `planReindex()` currently has **no caller**, so an operator cannot enumerate affected rows from the application |
| **N-3** | **Silent misconfiguration**: a malformed `NATIONAL_ID_HMAC_KEYS` currently fails closed with `503` but produces **no boot-time message**, so it looks identical to "feature off" | either accept that, or add a boot warning that names the problem without naming the key |
| **N-4** | **Masking surface**: nothing wires `linkIdentifier`/`listIdentifiers` to an HTTP route yet, so the masking change in #60 has no externally observable effect today | confirm that is intended for this PR rather than an omission |
| **N-5** | **MariaDB version authority**: the repo pins `mariadb:11.4` for compose and CI, while two security suites assert `10.11.14` and a dedicated database | CI now runs those suites in their own `mariadb:10.11.14` job; saying which version is authoritative is still an owner call |
| **N-6** | **Cross-version duplicates**: the unique key only covers one key version, so the same person can appear twice across a rotation; the application probe is TOCTOU under concurrency | decide whether a rotation must be exclusive (maintenance window) or needs a schema-level guard |

## 4. What this project never does

- Never stores a plaintext national ID in `employee_identifier`.
- Never stores an **unkeyed** hash: a Thai national ID has ~10¹² plausible values, so a plain SHA-256
  is reversible by enumeration.
- Never logs, returns in an API response, or writes to a fixture a raw national ID.
- Never treats a passed checksum as authorization: `citizenID` is not an identity (see the SSO
  standard's `PROVIDER_CONTRACT.md`, C-07/C-14).
