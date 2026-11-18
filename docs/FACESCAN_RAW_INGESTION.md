# FaceScan raw ingestion — Phase A

**Status:** Staging + batch + idempotency implemented in application code. Migration `014_facescan_raw_ingestion.sql` not applied until operator runs `npm run db:migrate`. **Phase B** (normalized attendance events → `daily_attendance`) is not started.

Device-side questions (which model, which port, which vendor path to pull from) are covered in
[`HIP_DEVICE_INGESTION.md`](./HIP_DEVICE_INGESTION.md). This file stays scoped to the app-side staging path.

## Identity flow

```text
HIP facescan_id (USERID)
  → employee_identifier (id_type = facescan_id)
  → employee_uid
  → staging_facescan_raw.employee_uid (when resolved)
```

Citizen ID (`national_id`) is **not** used for FaceScan raw ingestion.

## Tables

| Table | Purpose |
|-------|---------|
| `facescan_import_batches` | Batch metadata and counters |
| `staging_facescan_raw` | Immutable raw scan rows + resolution state |

### Idempotency

Unique `idempotency_key` = SHA-256 of `facescan_raw:v1|{facescan_id}|{scan_datetime}|{scan_type}`.

Duplicate inserts increment `duplicate_count` and return `resolution_status: duplicate` without a new row.

### Resolution status

| Status | Meaning |
|--------|---------|
| `resolved` | `facescan_id` mapped to `employee_uid` at ingest or re-resolve |
| `unmapped` | No active `employee_identifier` row for `facescan_id` |
| `duplicate` | Idempotency key already exists (not stored again) |

## Service

`createFacescanRawIngestionService({ repositories })`:

- `startBatch()` — open batch
- `ingestBatch(batchId, rawRows)` — ingest, resolve, commit batch
- `reResolveUnmapped({ batchId? })` — after new identifier links, promote unmapped rows
- `ingestFile(content, { sourceLabel? })` — HIP `csvExport` file → the same batch path (below)

No HTTP routes in Phase A (internal/service layer only).

### File ingestion (`csvExport` seam, `backend/src/imports/facescanCsvExport.js`)

The file uses the seam's canonical columns from `HIP_DEVICE_INGESTION.md` §6, by header name:
`facescan_id`, `scan_datetime`, optional `scan_type`. All other columns are dropped.

- UTF-8 (BOM allowed). A non-UTF-8 file is refused.
- `scan_datetime` is Asia/Bangkok wall clock: `YYYY-MM-DD HH:MM[:SS]` (CE) or `DD/MM/BBBB HH:MM[:SS]`
  (Buddhist era, −543). A zone suffix, an impossible date or an ambiguous era is refused.
- The whole file is validated before a batch exists. One bad line, an empty file or a header with no rows
  refuses the file with the offending line numbers, and no batch is created. A database error part-way
  through can still leave an `open` batch with some rows; re-importing the same file is safe, because the
  rows already stored come back as duplicates.
- Batch `source_system = hip_csv_export`, and `source_reference` records the label plus the file's SHA-256.
  `raw_payload` holds only the source line number.

**Still open (owner, `HIP_DEVICE_INGESTION.md` §8 Q3):** the vendor's own export layout. Until a
PII-stripped sample is reviewed, a vendor file must be mapped to these three headers first. This module
does not guess the vendor columns.

## Tests

- `backend/tests/facescanRawIngestion.test.js` — mapped, unmapped, duplicate, re-resolution.
- `backend/tests/facescanFileIngestion.test.js` — parser rules, refusal, quarantine, re-import, fixture chain.
- `backend/tests/facescanFileChain.mariadb.test.js` — file → staging → events → daily → monthly on MariaDB.

## Next (Phase B)

Normalize resolved raw rows into attendance events and persist to `daily_attendance` (separate design).
