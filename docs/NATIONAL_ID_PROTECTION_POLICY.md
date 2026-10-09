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

## Shared identifier contract (for `scripts/data-onboarding/idcardCsvLib.mjs` in the main workspace � not modified here)
That file (uncommitted in main workspace) must adopt this PR's contract before it can feed batches:
| Item | Main-workspace `idcardCsvLib.mjs` | Contract (this PR) |
|---|---|---|
| HMAC message | `employee-identifier:v1:<type>:<value>` | `rae-attendance-v2:identifier-lookup:v1\0<type>\0<value>` � **digests differ; mixing them breaks lookups** |
| Key version | none | `EMPLOYEE_IDENTIFIER_HMAC_KEY_VERSION` stored in `lookup_key_version` + previous-key window |
| Raw storage | `protectIdentifier()` always encrypts | disabled by default; needs `..._RAW_STORAGE_ENABLED=true` and `necessityApprovalRef` |
| AES-GCM AAD | `employee-identifier:v1:<type>:<hmac>` | `rae-attendance-v2:identifier-secret:v1:<type>:<hmac>` |
| Encryption key | always required | only when raw storage enabled |
| Secret sources | env only | env or `<NAME>_FILE` |
| Validation | 13 digits + Thai checksum | 13 digits (checksum may be added as a hold rule, not a lookup rule) |
| Output | base64 strings | `Buffer`s for DB binary columns |
| Scope | national_id + facescan_id | national_id only (facescan/personnel_id are stored as plain `id_value`) |
Plan: delete the duplicate crypto in `idcardCsvLib.mjs` and import `identifierCrypto.mjs` after this PR merges (or copy the module verbatim until then); keep masking helpers.
