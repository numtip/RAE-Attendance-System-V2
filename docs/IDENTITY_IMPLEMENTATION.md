# Identity foundation implementation (V2)

**Status:** Application code + migration `013_employee_identifier_foundation.sql` (not applied in repo ops yet). SSO callback, FaceScan ingestion, and Person API runtime remain out of scope.

## Locked identity roles

| Role | Identifier | Table / column | Use |
|------|------------|----------------|-----|
| **Canonical application identity** | `employee_uid` | `employees.employee_uid` | Attendance, leave, reports, sessions, RBAC |
| **MJU SSO / identity resolution** | Citizen ID (`national_id`) | `employee_identifier` | Deterministic SSO subject resolution path only — **not** an attendance key |
| **Attendance source (HIP)** | `facescan_id` (USERID) | `employee_identifier` | Maps device user id → `employee_uid` at ingestion boundary (ingestion not implemented yet) |
| **Personnel codes** | `employee_id`, `personnel_id` | `employees.employee_id` + `employee_identifier` | HR/business codes; API may accept `employee_id` at the edge |

**Required flows:**

```text
MJU SSO citizen_id (national_id) → employee_identifier → employee_uid
HIP facescan_id → employee_identifier → employee_uid
```

SSO **provider subject** (opaque claim) remains in `employee_identity_links`, not duplicated in `employee_identifier`.

## Final schema (`employee_identifier`)

Migration **`database/migrations/013_employee_identifier_foundation.sql`** (after `003`):

| Column | Notes |
|--------|--------|
| `employee_uid` | FK → `employees.employee_uid` (RESTRICT) |
| `id_type` | ENUM: `employee_id`, `personnel_id`, `facescan_id`, `national_id` |
| `id_value` | External value; citizen ID stored for SSO resolution only |
| `source_system`, `status`, `verified_at` | Provenance and soft unlink |
| UNIQUE | `(id_type, id_value)` |
| INDEX | `(employee_uid, id_type)` |

### Migration safety

No auto data repair. Fails on duplicate `(id_type, id_value)` or orphan `employee_uid`. Preflight SQL in previous revision still applies (duplicates / orphans).

## Service behavior

**`employeeIdentityService`** (`backend/src/services/employeeIdentityService.js`):

| Method | Behavior |
|--------|----------|
| `resolve(type, value)` | Returns employee profile (includes `employeeUid`) |
| `resolveUid(type, value)` | Returns `employee_uid` string |
| `linkIdentifier` / `unlinkIdentifier` | No silent reassignment; duplicate → 409 |
| `listIdentifiers` | Masks `national_id` (`idValue` omitted, `idValueMasked` only) |

Supported resolve types: `national_id`, `facescan_id`, `employee_id`, `personnel_id`.

## Privacy controls (citizen ID)

- Stored in `employee_identifier` for **identity resolution only**
- **Never** in normal API list output (raw), logs, errors, attendance/leave/report tables, or UI
- `listIdentifiers`: masked form only (`****1234`)
- Error messages use type-only text (`notFoundMessage`)

## Attendance internal id flow

Public RAE route still accepts **`employee_id`** on the request body.

```text
POST /attendance/evaluate-day { employee_id, ... }
  → resolve employee_id → employee_uid (identity service)
  → Attendance Core payload includes employee_uid (+ employeeUid) for evaluation
  → employee_id retained on payload for backward compatibility at the boundary
```

Implementation: `attendanceComputeService.buildCoreEvaluateDayPayload`.

FaceScan ingestion is **not** implemented; future path will resolve `facescan_id` → `employee_uid` before writes to `daily_attendance`.

## Code map

| Piece | Path |
|-------|------|
| Types / mask | `backend/src/domain/employeeIdentifier.js` |
| Service | `backend/src/services/employeeIdentityService.js` |
| Repos | `fixtureEmployeeIdentifierRepository.js`, `employeeIdentifierMariaDbRepository.js` |
| Attendance boundary | `backend/src/services/attendanceComputeService.js` |

## Tests

| Suite | Notes |
|-------|--------|
| `backend/tests/employeeIdentity.test.js` | All four resolve types, privacy, duplicates |
| `backend/tests/employeeIdentifier.mariadb.test.js` | Skipped unless `RUN_MARIADB_TESTS=1` or CI + DB |
| `npm test`, `npm run contract:smoke` | Required before commit |

## Unresolved

- HTTP SSO callback still email-based until MJU subject contract
- FaceScan staging / ingestion
- Public admin API for identifier CRUD
- Optional FK from `daily_attendance.employee_uid` → `employees`

## Related

- Design: `docs/IDENTITY_CONTRACT.md`
- SSO links: `docs/IDENTITY_LINK_MODEL.md`
