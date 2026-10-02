# FaceScan ingestion — Phase A (HIP Pm2014)

**Status:** Phase A raw staging + batch + idempotency; Phase B normalized **`attendance_events`** (migration **`016`**). Migrations **`014`** + **`015`** (HIP Pm2014). **No** late/early/work rules, `daily_attendance`, transport, or production sync.

## HIP source model

**Database:** HIP Premium Time / Pm2014 (Access `.mdb` / ODBC — transport not in this phase).

| Table | Fields used |
|-------|-------------|
| **USERINFO** | `USERID` (= FaceScan external id), `Badgenumber`, `Name`, card/group metadata |
| **CHECKINOUT** | `USERID`, `CHECKTIME`, `CHECKTYPE`, `VERIFYCODE`, `SensorID`, `WorkCode` |

Identity (never by display name):

```text
CHECKINOUT.USERID → employee_identifier.facescan_id → employees.employee_uid
```

## Architecture flow

```text
[Future: MDB/ODBC/CSV/MariaDB mirror] → normalized CHECKINOUT rows
  → facescanIngestionService.ingestCheckinoutBatch
  → staging_facescan_raw (+ batch counters)
  → optional staging_facescan_users (USERINFO, diagnostics only)
```

Extraction and ingestion are **separate** — this service is transport-neutral.

## Migration history

| Migration | Role |
|-----------|------|
| `014_facescan_raw_ingestion.sql` | Merged skeleton (`id` batch, `idempotency_key`) — **do not edit** |
| `015_facescan_hip_ingestion.sql` | Drops empty 014 tables; creates HIP batch/raw/users schema |

Apply in order via `npm run db:migrate`. **015** uses `DROP TABLE` on 014 staging tables — safe only when those tables have no production data.

## Staging schema

### `facescan_import_batches`

| Column | Purpose |
|--------|---------|
| `batch_uid` | Primary key |
| `source_system` | Default `hip_pm2014` |
| `source_type` | e.g. `checkinout` |
| `source_reference` | File/export label (no secrets) |
| `window_from` / `window_to` | Optional import window |
| `rows_*` | read, inserted, duplicate, unmapped, failed |
| `status` | `open`, `completed`, `failed` |

### `staging_facescan_raw`

Source facts only — **no** late/early/work minutes/work_date.

| Column | Purpose |
|--------|---------|
| `source_event_key` | Unique idempotency key (SHA-256) |
| `facescan_id` | HIP `USERID` |
| `check_time` | Bangkok wall datetime (see timezone) |
| `check_type`, `verify_code`, `sensor_id`, `work_code` | HIP columns preserved |
| `employee_uid` | Nullable; set when mapped |
| `resolution_status` | `resolved`, `unmapped` only (malformed rows are not inserted) |
| `import_batch_uid` | FK to batch |
| `raw_payload` | JSON snapshot of normalized input row |

### `staging_facescan_users`

Optional USERINFO staging — **not** used for identity matching.

## Event key strategy

```
SHA-256 hex of:
  hip_checkinout:v1|{USERID}|{check_time}|{sensor_id}|{check_type}|{verify_code}|{work_code}
```

- Missing optional fields → `-` in canonical string.
- **USERID + CHECKTIME + SensorID** alone is insufficient when the same second can appear on multiple sensors; **CHECKTYPE**, **VERIFYCODE**, and **WorkCode** are included so distinct HIP rows stay distinct.
- Re-import of the same logical row → duplicate (counter only, no second row).

## Identity resolution

Uses `employeeIdentityService.resolveUid('facescan_id', USERID)`.

- Mapped → `resolution_status = resolved`, `employee_uid` set.
- Unknown id → `unmapped` (row retained).
- Malformed USERID/CHECKTIME → `rows_failed` increment only; **no** `staging_facescan_raw` row (not `invalid` status).

## Unmapped handling

Unmapped rows remain in `staging_facescan_raw` for operator linking via `employee_identifier`.

## Reprocessing

`reResolveUnmapped({ importBatchUid? })` updates only `employee_uid`, `resolution_status`, `resolved_at`. **Does not** change `facescan_id`, `check_time`, `source_event_key`, or `raw_payload`.

## Timezone

- Business/source timezone: **Asia/Bangkok**.
- `CHECKTIME` stored as naive `DATETIME` in Bangkok wall time (`utils/bangkokTime.js`).
- No Buddhist year conversion in storage.
- No `work_date` derivation in Phase A.

## Privacy

- Do not log full USERINFO names in ingestion errors.
- `staging_facescan_users.display_name` is diagnostic metadata only — not a matching key.

## Error handling

- Batch stays `completed` with non-zero `rows_failed` when individual rows fail validation.
- Duplicate events do not fail the batch.

## Future transport (out of scope)

| Option | Notes |
|--------|--------|
| MDB / ODBC | Read CHECKINOUT + USERINFO, map to normalized rows |
| CSV export | Same normalized shape |
| MariaDB mirror | Bulk SELECT → ingest service |

## Service API

`createFacescanIngestionService({ repositories })`:

- `startBatch(input)`
- `ingestCheckinoutBatch(batchUid, checkinoutRows, options?)`
- `reResolveUnmapped({ importBatchUid? })`
- `ingestUserinfoRows(userinfoRows, options?)`

## Tests

`backend/tests/facescanIngestion.test.js`

## Phase B — normalized `attendance_events`

Migration **`016_attendance_events.sql`**.

Service: `createFacescanNormalizationService({ repositories })`.

```text
staging_facescan_raw (resolution_status = resolved, employee_uid set)
  → facescanNormalizationService.normalizeResolved()
  → attendance_events (one row per staging raw id, idempotent)
```

| Rule | Behavior |
|------|----------|
| `employee_uid` | Required on normalized row |
| Unmapped raw | Skipped — no normalized event |
| Idempotency | UNIQUE `staging_facescan_raw_id` and `(source_system, source_event_key)` |
| Business rules | **None** — copies check_time, check_type, sensor, etc. |
| `daily_attendance` | **Not updated** |
| Timezone | `timezone_label = Asia/Bangkok`; `event_time` = raw `check_time` |
| Reprocessing | Safe after `reResolveUnmapped` — call `normalizeResolved` again |

**Not implemented:** late/early, work hours, work_date, leave, Attendance Core evaluation.

See `backend/tests/facescanNormalization.test.js`.
