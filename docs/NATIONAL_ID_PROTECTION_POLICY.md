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
| Raw value (only if necessity approved) | `employee_identifier_secret`: **AES-256-GCM** (`iv`, `auth_tag`, `enc_key_id`, `necessity_ref`, `retain_until`); AAD binds ciphertext to its lookup. App code refuses to encrypt without `necessityApprovalRef`. |
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
- Migration is additive and idempotent (information_schema guards, `IF NOT EXISTS`), nullable new column, no data rewrite. The `CHECK` is added in a single `ALTER`; legacy plaintext `national_id` rows make it fail without changes (use the reindex procedure first).
- DDL is non-transactional in MariaDB: recovery is rerun (idempotent) or `database/rollbacks/015_...down.sql` (outside `migrations/` so the runner never applies it). Take a backup first; the rollback drops the encrypted table, so export it first if it contains data.
- `013_personnel_identifier.sql` is a no-op stub (superseded by main's `013_employee_identifier_foundation.sql`, which already adds `personnel_id` and the unique key).
- Not applied to any production database by this change.
