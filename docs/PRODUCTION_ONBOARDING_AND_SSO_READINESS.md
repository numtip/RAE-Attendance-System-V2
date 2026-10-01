# Production onboarding and SSO readiness

**Scope:** GitHub only. No production database write, no live MJU call, no Release 2 features.

Companion pull requests:

- Data onboarding: [PR #17](https://github.com/numtip/RAE-Attendance-System-V2/pull/17)
- SSO activation prep: [PR #18](https://github.com/numtip/RAE-Attendance-System-V2/pull/18)

## Data source readiness

**PARTIAL.**

`docs/CURRENT_DATABASE_SCHEMA.md` records column metadata from `information_schema` after `SHOW COLUMNS` on `employees` failed with `ERROR 1932`. That metadata is not a row export.

| Candidate | Readiness |
|---|---|
| Recovered legacy logical export | Not in the repository. Not authoritative. |
| Trusted employee master | **UNKNOWN.** No named owner or file. |
| Attendance source | Catalog names exist, including facescan staging. Which file is current is **UNKNOWN.** |
| Leave source | `staging_leave` columns are documented. A usable export is **UNKNOWN.** V2 target is `employee_leave`. |
| Other verified exports | None. `canva_tokens` stays out. |

## Import readiness

**PARTIAL.**

`scripts/data-onboarding/` can inspect, validate, transform, dry-run, and reconcile a JSON file. The sample in git is synthetic. The tools do not open MariaDB.

Covered targets: `employees`, `employee_identifier`, `daily_attendance`, `monthly_summary`, `employee_leave` (from `staging_leave`), `leave_balance`.

Not imported: `refresh_tokens`, `auth_logs`, `system_logs`, password hashes, national IDs.

Still required before a load: an evidenced source file, a reviewed dry-run, and a separate approval to write `attendance_v2`. The V2 schema also has no unique key on `(employee_uid, date)`; the dry-run enforces that key, and a later migration is not part of this change.

## SSO readiness

**PARTIAL.**

| Item | Status |
|---|---|
| Proposed callback `https://raeservice.mju.ac.th/api/v1/auth/sso/callback` | Written down. **Not confirmed** with MJU. |
| Authorization URL | **UNKNOWN** |
| Token URL | **UNKNOWN** |
| Userinfo URL | **UNKNOWN** |
| Scopes | Default `openid profile email` is an assumption |
| Client ID / secret | **UNKNOWN** values. Secret stays empty in git. |
| Required claims | Code tries `email`, `mail`, `preferred_username`. MJU claim is **UNKNOWN.** |
| Employee match | `employees.email`, fail closed |
| `SSO_ENABLED` | Must stay `false` |

Mock tests cover a valid callback, invalid and reused state, missing claims, unknown employee, disabled employee, provider timeout, a token body without `access_token`, and a userinfo HTTP error.

## External blockers

1. No evidenced employee, attendance, or leave extract.
2. Legacy InnoDB recovery is still a separate problem and is not a source.
3. MJU has not confirmed the callback, endpoints, scopes, or claims.
4. SSO `state` is in memory, so more than one API process needs a shared store before go-live.
5. The callback redirects to `{APP_URL}/?sso=success` and does not give the browser the access or refresh token. A live login is blocked until that handoff is specified. Aligning the path with the public SPA is a separate operator step.

## Remaining VPS tasks (not done here)

1. After PR merge, deploy the chosen SHA through the existing release path. Do not hot-edit the live tree.
2. Keep `SSO_ENABLED=false` and `SSO_CALLBACK_CONFIRMED=false`.
3. When a source is evidenced, run the dry-run on that file **off** the server or against a copy, then request a separate import window.
4. Do not point the importer at the legacy MariaDB data directory.

## Approval gates

| Gate | Required before |
|---|---|
| Named source, checksum, and owner | Any import into `attendance_v2` |
| Dry-run validation and reconcile pass | The same import |
| Explicit import approval | SQL writes |
| MJU callback and URL confirmation | `SSO_CALLBACK_CONFIRMED=true` |
| One controlled live login, then disable drill | `SSO_ENABLED=true` |
