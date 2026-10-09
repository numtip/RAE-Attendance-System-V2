# National ID protection policy

Status: proposed — requires human approval before any production use. No production secret is created or rotated by this repo.

## Principles
- **Internal Employee ID (`employee_uid` / `employee_id`) is the primary identity.** National ID is only a lookup/matching attribute for SSO onboarding.
- Never auto-create a FaceScan ID. Never auto-link by name alone (name-only matches are `HOLD`).
- No plain SHA, no plaintext in DB, no raw ID in logs, PRs, test output, or reports (mask as `****NNNN`).

## Storage model (migration `015_employee_identifier_secure_lookup.sql`)
| Need | Mechanism |
|---|---|
| Exact lookup + uniqueness | `employee_identifier(id_type='national_id').id_value` = lowercase hex **HMAC-SHA-256**; `lookup_key_version` records the key. `UNIQUE(id_type,id_value)` (migration 013) enforces uniqueness; `CHECK` enforces 64-hex + version for `national_id`. |
| Raw value (**disabled by default**; only if necessity approved and `EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED=true`) | `employee_identifier_secret`: **AES-256-GCM** (`iv`, `auth_tag`, `enc_key_id`, `necessity_ref`, `retain_until`); AAD binds ciphertext to its lookup. App code refuses to encrypt without `necessityApprovalRef`. |
| Audit | `employee_identifier_access_audit`: action/actor/reason/key_version only — never identifier values. |

HMAC message = `rae-attendance-v2:identifier-lookup:v1 \0 id_type \0 normalized_value` (domain separated; 13-digit normalization).

## Keys
- HMAC key and encryption key are **separate**, base64, loaded from environment or `<NAME>_FILE` secret mounts (secret manager / Docker / k8s). Equal keys are rejected at load. Key bytes never appear in logs or errors (error `code` only).
- Variables: see `.env.example` (names only).
- Least privilege: app role gets `SELECT/INSERT/UPDATE` on `employee_identifier`; **only** a dedicated decrypt role gets `SELECT` on `employee_identifier_secret`; audit table is `INSERT/SELECT` only; the import operator has no access to the encryption key.

## Audit
Every `create`, `decrypt`, `reindex`, `delete`, `key_rotation` writes an audit row (actor, reason, key_version, time). `lookup` is logged on SSO match decisions (employee_uid + result only).

## Retention
- Lookup HMAC: life of the employee record plus the legal retention period.
- Encrypted raw value: **default none**. If approved, `retain_until` is mandatory (max = approved necessity period); a scheduled job deletes expired rows and writes a `delete` audit event.
- Import batch files (private dir) are deleted after reconciliation sign-off + 30 days at most; checksums and masked reports may be kept.

## Key rotation / reindex plan (HMAC)
1. Generate the new key in the secret manager (human action); set `..._KEY_VERSION=N+1`, move the old key to `..._PREVIOUS` (+ `_PREVIOUS_VERSION=N`).
2. Deploy app: lookups use `buildLookupCandidates` (current + previous) so no outage.
3. Reindex needs raw values, which are not stored: run it from the **authoritative source** (MJU/CSV in the private dir) or from `employee_identifier_secret` if approved. For each row inside one transaction: recompute HMAC with the new key, `UPDATE id_value, lookup_key_version`, write `reindex` audit. Idempotent: rows already at version N+1 are skipped. Dry-run first, compare counts.
4. Verify: `SELECT lookup_key_version, COUNT(*) ... GROUP BY` shows only N+1; then remove the previous key. Rollback before step 4: switch the version env back (old key still present).
5. Encryption key rotation: re-wrap by decrypt → encrypt with new `enc_key_id` per row (decrypt role only), audited.

## Migration safety
- `database/preflight/015_preflight.sql` (read-only, counts only) must return all zeros before applying.
- Migration is additive and idempotent (information_schema guards, `IF NOT EXISTS`), nullable new column, no data rewrite. Legacy plaintext `national_id` rows make the `CHECK` step fail by design; only the NULLable `lookup_key_version` column is left behind and no ledger row is written (use the reindex procedure, then rerun).
- DDL is non-transactional in MariaDB: recovery is rerun (idempotent) or `database/rollbacks/015_...down.sql` (outside `migrations/` so the runner never applies it). Take a backup first; the rollback refuses (aborts) if the encrypted table contains rows, never drops the audit table, and keeps `lookup_key_version`.
- `013_personnel_identifier.sql` is a no-op stub (superseded by main's `013_employee_identifier_foundation.sql`, which already adds `personnel_id` and the unique key).
- Not applied to any production database by this change.

## Rotation review findings (verified on disposable MariaDB 10.3.39 and 10.11.9)
- **Cross-version duplicates:** the same person under key v1 and v2 produces different HMACs, so `UNIQUE(id_type,id_value)` cannot dedupe across versions (test: DB accepts it). Mitigations, all tested: (a) DB `UNIQUE(national_id_owner_uid)` = at most one national_id row per employee; (b) `detectCrossVersionDuplicates()` (current + previous key + legacy plaintext) must run inside the insert transaction before every national_id insert; (c) rotation reindexes **in place**, so a person never has two rows.
- **Reindex:** `planReindex()` is pure/idempotent, resolves raw only from the authoritative source (or legacy plaintext row), reports unresolved rows (never guesses), and refuses on collisions. Apply updates in one transaction guarded by `lookup_key_version <=> from_version`. The executor script is intentionally not shipped until key/approval gates clear.
- **Rotation rollback:** keep the previous key until verification. Rolling back = reindex back to the old version from the source with the old key as `current` (tested). After the old key is destroyed, rollback needs a full re-derivation from source.
- **Migration rollback:** keeps `lookup_key_version` (dropping it would lose which key produced each HMAC and break re-apply); drops the CHECK, owner key/column and the (empty) secret table; refuses if `employee_identifier_secret` has rows; never touches the audit table.

## Migration runner review
- `scripts/migrate.mjs` ledger = filename only in `schema_migrations`; **no checksum** � editing an applied file is not detected (hence 013_personnel_identifier is a no-op stub rather than deleted/renumbered, and new work is a new numbered file).
- The runner wraps each file in a transaction, but DDL auto-commits in MariaDB, so a mid-file failure leaves partial DDL and **no ledger row**. Therefore 015 is fully idempotent and the next run re-executes it. (Main's `013_employee_identifier_foundation.sql` is not idempotent; not changed here.)
- Version guard: 015 aborts before any DDL unless MariaDB >= 10.2.3 or MySQL >= 8.0.16 (CHECK is silently ignored on older servers). Verified on 10.3.39 and 10.11.9; MySQL 8 not tested.
- Legacy plaintext: preflight counts them (no values); 015 then fails at the CHECK step by design (only the NULLable column remains), reindex, rerun.

## Single National ID contract (`backend/src/security/nationalIdContract.js`)
One implementation, consumed by the backend (`employeeIdentifier` domain, repositories, `employeeIdentityService`), the onboarding scripts (`scripts/data-onboarding/identifierCrypto.mjs` is a thin ESM re-export) and, via `docs/patches/main-workspace-idcard-shared-contract.patch`, `idcardCsvLib.mjs` / `export-employee-bundle.mjs`.

| Decision | Contract |
|---|---|
| Lookup | `HMAC-SHA-256(key, "rae-attendance-v2:identifier-lookup:v1" \0 id_type \0 canonical)`; hex in `employee_identifier.id_value`, `lookup_key_version` beside it |
| Canonical input | NFKC; Thai/full-width digits to ASCII; only whitespace/hyphen separators removed; exactly 13 digits; anything else (`ID:...`, letters, 12/14 digits) is invalid, never "best effort" digit-stripped. Thai checksum is a separate screening rule |
| Keys | current + optional previous (own version); lookups try both (`buildLookupCandidates`); `<NAME>_FILE` supported; previous must differ from current; HMAC key must differ from encryption key |
| Raw storage | off by default; AES-256-GCM only with `EMPLOYEE_IDENTIFIER_RAW_STORAGE_ENABLED=true` **and** a `necessityApprovalRef`; `employee_identifier_secret` stays empty otherwise |
| Failure mode | fail closed: no key => `NATIONAL_ID_PROTECTION_UNAVAILABLE` (503), never a plaintext fallback; no name/e-mail-only auto-link anywhere |
| Audit | `employee_identifier_access_audit`: actor, action, key version, result, ref; `buildAuditEvent` rejects free text and any 10+ digit run. `create` audit is mandatory in the write transaction (outage rolls the write back); lookup audit is best-effort |
| Duplicates | `UNIQUE(id_type,id_value)` + `UNIQUE(national_id_owner_uid)` (generated; NULL for non-national so many other rows are allowed; a deactivated national row still blocks a second one, 409) + `GET_LOCK` + transaction + `FOR UPDATE` check across current and previous lookups |

### Error mapping (API)
`NATIONAL_ID_PROTECTION_UNAVAILABLE` 503, `NATIONAL_ID_WRITES_FROZEN` 503, `NATIONAL_ID_WRITE_BUSY` 503, `EMPLOYEE_ALREADY_HAS_NATIONAL_ID` 409, `DUPLICATE_IDENTIFIER` 409, invalid value 400 `VALIDATION_ERROR`. Messages never contain the identifier.

### Rotation procedure (mandatory write freeze)
A v1-only instance cannot see rows written under v2, so a mixed fleet can create cross-version duplicates that no index can catch. Therefore: (1) set `EMPLOYEE_IDENTIFIER_NATIONAL_WRITE_FREEZE=true` everywhere; (2) deploy current=v2 + previous=v1 on **all** instances; (3) run `planReindex` and re-key rows in place (needs a source of the original value, e.g. the approved private batch); (4) verify with `detectCrossVersionDuplicates`; (5) unfreeze; (6) retire v1 only after zero `lookup_key_version=1` rows remain. Tested on MariaDB 10.3.39 and 10.11.9 (including the documented v1-only hazard).

### Behaviour changes / caller compatibility
- `normalizeIdentifierValue('national_id', x)` returns canonical or `''` (previously digit-stripped fallback).
- Repository `idValue` is `null` for national rows; list API shows `idValueMasked: "[protected]"` and `lookupKeyVersion`.
- The MariaDB repository now selects `lookup_key_version`, so **migration 015 must be applied before the new backend is deployed**; the 015 down script keeps the column so older code remains readable.
- `export-employee-bundle.mjs` (patch): no key needed; exports `lookup_hmac` + `lookup_key_version` for national rows and refuses (without echoing) if a non-HMAC value is found.
- `idcardCsvLib.mjs` (patch): reconcile/classify take `{ keys }`; a plaintext 13-digit national_id in a snapshot throws `PLAINTEXT_NATIONAL_ID_IN_SNAPSHOT`; `facescan_id` stays a plain value. The patch applies to the CRLF originals in the main workspace (`git apply`), which this work deliberately did not modify.