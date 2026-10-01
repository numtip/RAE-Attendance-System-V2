# Data mapping (candidate only)

Targets are the V2 tables created by migrations 001–010. Source column names for the legacy catalog come from `docs/CURRENT_DATABASE_SCHEMA.md` (`information_schema` only). Where a source file has not been recovered, the source field is the catalog name and its authority is **UNKNOWN**.

Transforms below are what `scripts/data-onboarding/lib.mjs` does to a JSON bundle. They are not permission to load production.

## Identity and access fields the importer must be able to carry

| Need | Target | Rule |
|---|---|---|
| Identity mapping | `employees.email` | V2 SSO matches this column. The MJU claim name is still unknown. |
| Employee code | `employees.employee_id` | Natural key in the file. Not a session key. |
| Org unit | `employee_org_membership.org_unit_code` | Opaque code. `department` is not a hierarchy. |
| Role | `authorization_grants.role` | `EXECUTIVE`, `MANAGER`, `EMPLOYEE`, `ADMIN`. |
| Manager scope | `authorization_grants` with `scope_type=org_unit` | No invented parent unit. |
| Account status | `employees.status` | `active`, `inactive`, `resigned`. Inactive SSO login is refused. |

Do not import old sessions, refresh tokens, or auth secrets. Those columns are dropped.

## employees

| Source field | Target field | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `employee_uid` | `employee_uid` | Keep when present. Otherwise `stableEmployeeUid(employee_id)`. | Optional in source | UUID text when supplied | One row per `employee_id` | Generated when absent |
| `employee_id` | `employee_id` | Trim not applied; exact string | Required | Non-empty, unique | Reject file | No default |
| `first_name_th` / `last_name_th` | same | Copy | Required | Non-empty | n/a | No default |
| `first_name_en` / `last_name_en` | same | Copy | Optional | None | n/a | `NULL` |
| `email` | `email` | Lowercase | Required | Unique | Reject file | No default |
| `password_hash` | `password_hash` | **Drop.** Always `NULL` | Forbidden | `SECRET_PRESENT` if set | n/a | `NULL` |
| `last_login`, `login_attempts`, `locked_until` | same | **Do not copy** | Forbidden | Not loaded | n/a | `NULL` |
| `phone` | `phone` | Copy | Optional | None | n/a | `NULL` |
| `department` | `department` | Copy | Required | Non-empty | n/a | No default |
| `position` | `position` | Copy | Optional | None | n/a | `NULL` |
| `employee_type` | `employee_type` | Copy | Required | `university`, `department`, `contract` | n/a | No default |
| `hire_date` | `hire_date` | Copy | Optional | `YYYY-MM-DD` | n/a | `NULL` |
| `status` | `status` | Copy | Required | `active`, `inactive`, `resigned` | n/a | No default |
| `role` | `role` | Copy | Optional | Not re-enumerated here | n/a | `NULL` |
| `created_at` / `updated_at` | same | Copy or epoch placeholder `1970-01-01 00:00:00` | Optional | None | n/a | Placeholder |

No second employee master is named in the repo. Do not assume `employee_id` from an HR extract matches this column until that extract is evidenced.

## employee_identifier

| Source field | Target field | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `employee_id` or `employee_uid` | `employee_uid` | Resolve through the employee plan | Required | `UNKNOWN_EMPLOYEE` otherwise | n/a | No default |
| `id_type` | `id_type` | Copy | Required | `facescan_id` or `employee_id` | n/a | No default |
| `id_type=national_id` | — | **Drop the row** | Forbidden | `SENSITIVE_ID` | n/a | Omitted |
| `id_value` | `id_value` | Copy | Required | Non-empty | Unique `(id_type, id_value)` in the file | No default |
| `is_primary` | `is_primary` | `1` or `0` | Optional | None | n/a | `0` |

The V2 table has no unique key on `(id_type, id_value)`. The dry-run enforces uniqueness anyway.

## daily_attendance

| Source field | Target field | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `employee_id` | `employee_uid` | Resolve | Required | `ORPHAN_ATTENDANCE` | Unique `(employee, date)` | No default |
| `date` | `date` | Copy | Required | Real calendar date | Same | No default |
| `check_in` / `check_out` | same | Copy | Optional | Out not before in | n/a | `NULL` |
| `is_late` | `is_late` | `1` or `0` | Optional | None | n/a | `0` |
| `late_minutes` | `late_minutes` | Copy | Optional | None | n/a | `0` |
| `work_duration` | `work_duration` | Copy | Optional | None | n/a | `0` |
| `is_leave` | `is_leave` | `1` or `0` | Optional | None | n/a | `0` |
| `leave_type` | `leave_type` | Copy | Optional | Not checked against enum when null | n/a | `NULL` |
| `status` | `status` | Copy | Required | `present`, `late`, `absent`, `leave`, `holiday` | n/a | No default |
| `notes` | `notes` | Copy | Optional | None | n/a | `NULL` |

`staging_facescan` and `staging_facescan_daily` are documented catalog tables. This mapper does not read them. Whether they are the attendance source is **UNKNOWN**.

## monthly_summary

| Source field | Target field | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `employee_id` | `employee_uid` | Resolve | Required | Known employee | Unique `(employee, year, month)` | No default |
| `year` / `month` | same | Number | Required | Year 2000–2100, month 1–12 | Same | No default |
| count and hour columns | same | Copy | Optional | None | n/a | `0` |

Whether monthly rows should be imported or recomputed from `daily_attendance` is **UNKNOWN**. The mapper copies a supplied summary and does not recompute it.

## staging_leave → employee_leave

V2 has no `staging_leave` table. Release 1 leave rows live on `employee_leave` (`006_employee_leave.sql`).

| Source field | Target field | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `leave_id` | `leave_id` | Copy | Required | Non-empty | Unique `leave_id` | No default |
| `employee_id` or `employee_uid` | `employee_uid` | Resolve | Required | Known employee | n/a | No default |
| `national_id_encrypted` | — | **Omit** | Forbidden | `SECRET_PRESENT` | n/a | Dropped |
| `raw_data` | — | **Omit** | Forbidden | `SECRET_PRESENT` | n/a | Dropped |
| `leave_type` | `leave_type` | Copy | Required | `sick`, `personal`, `vacation`, `other` | n/a | No silent map to `other` |
| `start_date` / `end_date` | same | Copy | Required | Real dates, end on or after start | Overlap rejected | No default |
| `status` | `status` | Copy | Optional | None | n/a | `approved` only when missing |
| `match_status` | `match_status` | Copy | Optional | Stored as given | n/a | `pending` when missing |
| `is_processed`, `sync_date`, `error_message` | — | Not mapped | n/a | Ignored | n/a | Dropped |

`DATABASE_REUSE_PLAN.md` says to map `match_status = matched` for the read path. The dry-run keeps other `match_status` values so a reviewer can see them. It does not filter them out.

## leave_balance

| Source field | Target field | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `employee_id` | `employee_uid` | Resolve | Required | Known employee | Unique `(employee, year, leave_type)` in the file | No default |
| `year` | `year` | Number | Required | Present | Same | No default |
| `leave_type` | `leave_type` | Copy | Required | Balance enum, including maternity, paternity, study | Same | No default |
| `total_days`, `used_days`, `remaining_days` | same | Number | Required | `remaining = total - used` | n/a | No default |

## Role and organizational scope

`employees.department` is a label. It is not a hierarchy and this importer does not turn it into one. Scope arrives only as explicit rows.

| Source field | Target | Transform | Required | Validation | Duplicate policy | Null / default |
|---|---|---|---|---|---|---|
| `authorization_grants.employee_id` | `authorization_grants.employee_uid` | Resolve | Required | Known employee | Unique `(employee, role, scope_type, org_unit_code)` | No default |
| `role` | `role` | Copy | Required | `EXECUTIVE`, `MANAGER`, `EMPLOYEE`, `ADMIN` | Same | No default |
| `scope_type` | `scope_type` | Copy | Required | `self`, `org_unit`, `organization` | Same | No default |
| `org_unit_code` | `org_unit_code` | Copy for `org_unit` only | Required for `org_unit` | Opaque code. `organization` must not also carry a code. Manager plus `organization` is rejected. | Same | `NULL` except `org_unit` |
| `employee_org_membership.employee_id` | `employee_org_membership.employee_uid` | Resolve | Required | Known employee | Unique `(employee, org_unit_code)` | No default |
| `employee_org_membership.org_unit_code` | same | Copy | Required | Non-empty opaque code | Same | No default |

Legacy `admin` / `manager` / `user` values are not rewritten here. The API maps those stored values at read time. An import that wants the four roles must send those four names.

## Not migrated

| Table | Policy |
|---|---|
| `refresh_tokens` | Create on V2 login. Never copy `token`. |
| `auth_logs` | Start empty. |
| `system_logs` | Not an import target. |
| `canva_tokens` | Out of scope. |
| `schema_migrations` | Owned by `scripts/migrate.mjs`, not by this importer. |
