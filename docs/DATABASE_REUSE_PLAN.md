# Database reuse plan

V2 reuses the production schema. It does not create a second attendance model in this phase, and it does not alter production.

## Blocker

`employees` does not open in the storage engine (`ERROR 1932`) even though `information_schema` still lists its columns. Views that depend on it fail the same way. Release 1 must not pretend it can query live rows until that is investigated and fixed under a separate approval. This repository does not run `REPAIR` or any write.

## Reuse

| Object | Release 1 use | Rule |
|---|---|---|
| employees | login, current user, profile | Select profile columns. Never return `password_hash`. |
| employee_identifier | lookup facescan and employee codes | Do not log `national_id` values. |
| daily_attendance | daily attendance | Read by `employee_uid` and `date`. |
| monthly_summary | monthly attendance | Read by `employee_uid`, `year`, `month`. |
| leave_balance | balance | Read by `employee_uid` and `year`. |
| staging_leave | leave list and history | Map `match_status = matched` rows. Omit `national_id_encrypted` and `raw_data`. |
| auth_logs | login audit | Insert only after a reviewed write window. Bootstrap does not insert. |
| refresh_tokens | refresh and logout | Store a hash of the refresh token if the column width allows a later migration. Until then, treat `token` as secret. Bootstrap does not insert. |
| system_logs | optional later diagnostics | Not in the Release 1 read path. |

## Reference only until a later release

| Object | Why it waits |
|---|---|
| staging_facescan | Scan-level staging is outside Release 1. |
| staging_facescan_daily | Used by the admin CSV flow, which is out of scope. |
| facescan_daily_import_batches | Same admin import flow. |
| vw_attendance_daily | Unreadable today, and the base table is enough for Release 1 if the engine error is fixed. |
| vw_monthly_report | Same as above. `monthly_summary` is the table to read first. |

## Retired for V2

| Object | Why |
|---|---|
| canva_tokens | Canva is not part of V2. Do not copy tokens. |
| report_audit_logs | Not present. Do not invent it in production from this bootstrap. |

## Connection

A future V2 process uses its own database user with least privilege. Credentials live outside git. The legacy `.env` is not copied into this repo.
