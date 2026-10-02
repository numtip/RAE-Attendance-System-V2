# Import batch approval (dry-run only)

**Status:** Prepare and validate only. No import is authorized from this document.

## Source batch audit

Each approved batch carries:

| Field | Purpose |
|---|---|
| `source_batch_id` | Stable batch identifier for rollback and audit |
| `input_sha256` | Checksum of the operator input file |
| `owner` | Who prepared the batch |
| `captured_at_utc` | When the batch was built |
| `person_source` | `mju_person_api` when MJU Person API is authoritative |

Store full input and preview bundles under `.local/import-batches/` (gitignored, mode 600). Do not commit raw national IDs.

## Candidate rules

- **Ready:** `PERSONNEL_ID_VERIFIED_FROM_MJU`, plus required employee attributes, `nationalId`, and `facescanId`; unique across the ready set.
- **Hold:** missing `personnelId` or other required fields; duplicate identifiers; non-authoritative source.

`employee_uid` in preview JSON is deterministic for review only. **Approved import must allocate fresh UUIDs** with `randomUUID()` immediately before INSERT.

`employee_id` uses immutable `RAE-########` sequence from `sequence_start` (default 1).

## Transaction design

Per candidate (or whole batch in one transaction):

```text
BEGIN;
  INSERT INTO employees (...);
  INSERT INTO employee_identifier (... id_type=facescan_id ...);
  INSERT INTO employee_identifier (... id_type=personnel_id ...);
COMMIT;
```

National ID: validated for uniqueness via `identifier_audit.national_id_sha256` in the preview bundle. Raw `national_id` rows are **not** part of the standard import dry-run until a separate storage policy is approved.

On error: `ROLLBACK`. If a partial load occurred outside this pattern, delete using `rollbackKeys` from the approved dry-run report (employees and identifiers, reverse dependency order).

## Commands

```bash
node scripts/data-onboarding/prepare-import-batch.mjs path/to/person-batch.json
node scripts/data-onboarding/prepare-import-batch.mjs path/to/person-batch.json --write-local
node scripts/data-onboarding/import-dry-run.mjs .local/import-batches/<source_batch_id>.preview.json
```

Synthetic shape check only:

```bash
node scripts/data-onboarding/prepare-import-batch.mjs scripts/data-onboarding/sample/person-batch-50-synthetic.json
```
