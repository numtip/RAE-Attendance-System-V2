# FaceScan raw ingestion — Phase A

**Status:** Staging + batch + idempotency implemented in application code. Migration `014_facescan_raw_ingestion.sql` not applied until operator runs `npm run db:migrate`. **Phase B** (normalized attendance events → `daily_attendance`) is not started.

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

No HTTP routes in Phase A (internal/service layer only).

## Tests

`backend/tests/facescanRawIngestion.test.js` — mapped, unmapped, duplicate, re-resolution.

## Next (Phase B)

Normalize resolved raw rows into attendance events and persist to `daily_attendance` (separate design).
