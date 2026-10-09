# Controlled employee onboarding (dry-run design)

**Status:** application dry-run implemented; database migration is proposed only and has not been applied.

## Authority and boundaries

- Source: `database/IDCardRaecsv2027.csv` (gitignored operator file).
- Match only `national_id` and `facescan_id`. Names, email, and organization text are never matching keys.
- The dry-run performs no database writes and emits no raw identifier values.
- `employee_uid` is an application-generated UUID v4. It is immutable and is generated only after an approved import.
- No automatic merge is allowed.

## Dry-run decisions

- Neither identifier exists: `CREATE_CANDIDATE`.
- Both identifiers resolve to the same employee: `NOOP`.
- Exactly one identifier exists: `ATTACH_REVIEW`.
- Identifiers resolve to different employees, an existing identifier is ambiguous, the CSV cross-maps identifiers, or validation fails: `HARD_CONFLICT`.

Exact duplicate CSV rows are deduplicated before classification. Thai national IDs require 13 digits and a valid check digit. FaceScan IDs are trimmed digit strings; leading zeroes are preserved.

## Identifier protection

Lookup uses:

```text
HMAC-SHA256(hmac_key, "employee-identifier:v1:" + id_type + ":" + normalized_value)
```

Raw normalized values use AES-256-GCM with a random 96-bit IV and authenticated context containing the identifier type and lookup HMAC. The HMAC key and encryption key are separate secrets; startup/dry-run rejects key reuse.

Environment contract:

```text
EMPLOYEE_IDENTIFIER_HMAC_KEY=<base64, at least 32 bytes>
EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY=<base64, exactly 32 bytes>
EMPLOYEE_IDENTIFIER_ENCRYPTION_KEY_ID=<non-secret key version>
```

## Minimal safe migration proposal

This must be split into two approved migrations because existing `employee_identifier.id_value` rows contain plaintext and cannot be cryptographically backfilled by SQL without application-held keys.

Phase A — additive, before controlled backfill:

```sql
ALTER TABLE employee_identifier
  ADD COLUMN lookup_hmac CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER id_value,
  ADD COLUMN encrypted_value VARBINARY(512) NULL AFTER lookup_hmac,
  ADD COLUMN encryption_iv BINARY(12) NULL AFTER encrypted_value,
  ADD COLUMN encryption_auth_tag BINARY(16) NULL AFTER encryption_iv,
  ADD COLUMN encryption_key_id VARCHAR(64) NULL AFTER encryption_auth_tag,
  ADD UNIQUE KEY uk_employee_identifier_type_hmac (id_type, lookup_hmac);
```

`employees` needs no column migration: `employee_uid VARCHAR(36)` is already the primary key. The approved writer must use `crypto.randomUUID()` and must never derive the UID from CSV data.

Phase B — only after an approved, verified cryptographic backfill and runtime cutover:

```sql
ALTER TABLE employee_identifier
  MODIFY lookup_hmac CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  MODIFY encrypted_value VARBINARY(512) NOT NULL,
  MODIFY encryption_iv BINARY(12) NOT NULL,
  MODIFY encryption_auth_tag BINARY(16) NOT NULL,
  MODIFY encryption_key_id VARCHAR(64) NOT NULL,
  DROP INDEX uk_employee_identifier_type_value,
  DROP COLUMN id_value;
```

Phase B must fail closed if any secure field is null. Do not apply either phase from the dry-run command.

## Import batch and audit proposal

Add three tables in the approved migration:

1. `employee_onboarding_batches`
   - `batch_uid` UUID primary key
   - source SHA-256 and non-sensitive source label
   - status: `dry_run`, `pending_approval`, `approved`, `rejected`, `applied`, `failed`
   - source, staged, duplicate, validation, and four classification counts
   - creator, approver, timestamps
2. `employee_onboarding_stage`
   - batch FK and source row number
   - two lookup HMACs plus AES-GCM ciphertext/IV/tag/key-id fields
   - classification, reason code, nullable matched employee UID
   - nullable proposed employee UID, populated only after approval
   - unique `(batch_uid, source_row_number)`
   - no name, email, organization text, or raw identifier columns
3. `employee_onboarding_audit`
   - append-only event UID, batch FK, optional staged-row FK
   - actor UID, event type, sanitized JSON metadata, timestamp
   - metadata allowlist must reject raw CSV fields and identifier values

Approval and apply must be separate transactions/actions. A batch containing any `HARD_CONFLICT` cannot be approved. `ATTACH_REVIEW` requires an explicit reviewer decision; it must never auto-attach.

## Local command

```text
node scripts/data-onboarding/reconcile-idcard-csv.mjs database/IDCardRaecsv2027.csv [gitignored-bundle.json]
```

The optional bundle is a read-only employee/identifier snapshot. Without it, conflict detection can only classify against an empty snapshot, so the result is not ready for approved import.
