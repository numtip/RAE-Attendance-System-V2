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

### HIP daily report (`backend/src/imports/hipDailyReport.js`)

The HIP Premium Time daily report (`รหัสที่เครื่อง`, `วัน/เวลา` as `DD/MM/BBBB`, slot pairs `เข้า [n]` / `ออก [n]`)
is read directly: each non-empty slot time becomes one `in` / `out` scan row. These are **report-derived**
times, not device punches: the batch, its staging rows and their events carry
`source_system = hip_daily_report`, and each row's payload says `origin: report_derived`. Names and every
other report column are dropped. A day with no times creates nothing. Same fail-closed rules as above, plus:
a time inside the date cell, two rows for the same code and date, or an `ออก` before its `เข้า` refuses the file.

### Operator entry point: `facescan:import`

```bash
# dry run (default): parse, idempotency and identity checks, no write; aggregates only
docker exec -i <backend> node src/imports/facescanImportCli.js - --format hip-daily < report.csv
# import into staging (needs DATA_SOURCE=mariadb)
… --format hip-daily --label <text> --confirm
# import, then derive each resolved employee-day through the AR-0001 record path
… --format hip-daily --confirm --derive --operator <employee_uid>
```

`--derive` acts as that employee with their own role and grants (the HTTP route's RBAC); without data scope
it is refused before anything is written. Exit codes: 0 ok, 2 usage, 3 file refused, 4 not authorised,
5 some employee-days not derived. Unmapped codes stay quarantined until a `facescan_id` identifier exists.

## Tests

- `backend/tests/facescanRawIngestion.test.js` — mapped, unmapped, duplicate, re-resolution.
- `backend/tests/facescanFileIngestion.test.js` — parser rules, refusal, quarantine, re-import, fixture chain.
- `backend/tests/facescanFileChain.mariadb.test.js` — file → staging → events → daily → monthly on MariaDB.

## Next (Phase B)

Normalize resolved raw rows into attendance events and persist to `daily_attendance` (separate design).
