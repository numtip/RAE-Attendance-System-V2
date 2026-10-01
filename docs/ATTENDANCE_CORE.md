# Attendance Core integration (RAE V2)

Attendance **business rules** are not implemented in Node. RAE proxies evaluation to Attendance Core over HTTP.

**Canonical core repo:** https://github.com/numtip/attendance-core  
**Documentation:** https://github.com/numtip/attendance-core/tree/main/docs

## Configuration

```env
ATTENDANCE_CORE_URL=http://127.0.0.1:8765
ATTENDANCE_POLICY_PATH=<path to shared YAML policy>
```

Start Core API: `python -m attendance_core.api.server` (see core README).

## API routes (RAE)

- `POST /api/v1/attendance/evaluate-day`
- `POST /api/v1/attendance/evaluate-period`
- `POST /api/v1/attendance/explain`

Requires admin/manager role. Returns 503 when `ATTENDANCE_CORE_URL` is unset or Core is down.

## Phase 2

- `employee_identifier` repository wiring
- Persist evaluated rows to `daily_attendance` (not enabled in this phase)
