# Current database schema

Read on 2026-10-01 from `information_schema.COLUMNS` of the production attendance database. No rows were selected. No schema was changed.

Opening `employees` with `SHOW COLUMNS` failed:

`ERROR 1932 (42S02): Table 'attendance_db.employees' doesn't exist in engine`

`SHOW COLUMNS` on `vw_attendance_daily` failed with the same engine error because the view depends on `employees`. Column metadata below still came from `information_schema`. Treat live reads as unavailable until that storage error is investigated in a separate, approved change. This bootstrap does not repair it.

`report_audit_logs` is not in the table list.

`canva_tokens` exists and is out of V2 scope. Its token columns are omitted here on purpose.

## employees

Primary key `employee_uid` varchar(36). Unique `employee_id`, unique `email`.

| Column | Type | Null | Key |
|---|---|---|---|
| employee_uid | varchar(36) | NO | PRI |
| employee_id | varchar(50) | NO | UNI |
| first_name_th | varchar(100) | NO | |
| last_name_th | varchar(100) | NO | |
| first_name_en | varchar(100) | YES | |
| last_name_en | varchar(100) | YES | |
| email | varchar(100) | NO | UNI |
| password_hash | varchar(255) | YES | |
| last_login | datetime | YES | |
| login_attempts | int(11) | YES | |
| locked_until | datetime | YES | |
| phone | varchar(20) | YES | |
| department | varchar(100) | NO | MUL |
| position | varchar(100) | YES | |
| employee_type | enum('university','department','contract') | NO | MUL |
| hire_date | date | YES | |
| status | enum('active','inactive','resigned') | NO | MUL |
| role | enum('admin','manager','user') | YES | |
| created_at | datetime | NO | |
| updated_at | datetime | NO | |

## employee_identifier

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| employee_uid | varchar(36) | NO | MUL |
| id_type | enum('facescan_id','national_id','employee_id') | NO | MUL |
| id_value | varchar(255) | NO | MUL |
| is_primary | tinyint(1) | NO | |
| created_at | datetime | NO | |
| updated_at | datetime | NO | |

`id_type = national_id` is sensitive. Repositories must not log `id_value` for that type.

## daily_attendance

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| employee_uid | varchar(36) | NO | MUL |
| date | date | NO | MUL |
| check_in | datetime | YES | |
| check_out | datetime | YES | |
| is_late | tinyint(1) | NO | |
| late_minutes | int(11) | NO | |
| work_duration | decimal(5,2) | NO | |
| is_leave | tinyint(1) | NO | |
| leave_type | enum('sick','personal','vacation','other') | YES | |
| status | enum('present','late','absent','leave','holiday') | NO | MUL |
| notes | text | YES | |
| created_at | datetime | NO | |
| updated_at | datetime | NO | |

## monthly_summary

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| employee_uid | varchar(36) | NO | MUL |
| year | int(11) | NO | MUL |
| month | int(11) | NO | |
| total_work_days | int(11) | NO | |
| total_present | int(11) | NO | |
| total_late | int(11) | NO | |
| total_absent | int(11) | NO | |
| total_leave | int(11) | NO | |
| total_late_minutes | int(11) | NO | |
| total_work_hours | decimal(6,2) | NO | |
| created_at | datetime | NO | |
| updated_at | datetime | NO | |

## staging_facescan

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| facescan_id | varchar(10) | NO | MUL |
| scan_datetime | datetime | NO | MUL |
| scan_type | enum('in','out','unknown') | NO | |
| raw_data | longtext | YES | |
| is_processed | tinyint(1) | NO | MUL |
| processed_at | datetime | YES | |
| employee_uid | varchar(36) | YES | MUL |
| error_message | text | YES | |
| created_at | datetime | NO | |

## staging_facescan_daily

| Column | Type | Null | Key |
|---|---|---|---|
| id | varchar(36) | NO | PRI |
| import_batch_id | varchar(36) | NO | MUL |
| source_filename | varchar(255) | NO | |
| imported_at | datetime | YES | |
| employee_ref | varchar(50) | NO | MUL |
| employee_name_raw | varchar(255) | YES | |
| department_raw | varchar(255) | YES | |
| work_date | date | NO | MUL |
| day_status | varchar(50) | YES | |
| work_duration | varchar(20) | YES | |
| first_in_time | time | YES | |
| last_out_time | time | YES | |
| late_duration | time | YES | |
| early_leave_duration | time | YES | |
| remark | text | YES | |
| employee_id | varchar(36) | YES | MUL |
| row_hash | char(64) | NO | UNI |
| raw_row_json | longtext | YES | |

## facescan_daily_import_batches

| Column | Type | Null | Key |
|---|---|---|---|
| id | varchar(36) | NO | PRI |
| source_filename | varchar(255) | NO | |
| total_rows | int(11) | NO | |
| inserted_rows | int(11) | NO | |
| updated_rows | int(11) | NO | |
| duplicate_rows | int(11) | NO | |
| rejected_rows | int(11) | NO | |
| matched_employees | int(11) | NO | |
| unmatched_employees | int(11) | NO | |
| imported_by | varchar(255) | NO | |
| imported_at | datetime | YES | MUL |
| status | enum('processing','completed','failed') | YES | MUL |
| error_summary | text | YES | |

## staging_leave

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| leave_id | varchar(100) | NO | UNI |
| employee_id | varchar(20) | YES | MUL |
| employee_uid | varchar(36) | YES | MUL |
| national_id_encrypted | text | YES | |
| leave_type | varchar(50) | YES | |
| start_date | date | NO | MUL |
| end_date | date | NO | |
| status | varchar(20) | YES | |
| is_processed | tinyint(1) | YES | MUL |
| match_status | enum('matched','unmatched','pending') | YES | MUL |
| sync_date | datetime | YES | MUL |
| raw_data | text | YES | |
| error_message | text | YES | |
| created_at | datetime | YES | |
| updated_at | datetime | YES | |

`national_id_encrypted` and `raw_data` are sensitive. V2 leave list must not return them by default.

## leave_balance

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| employee_uid | varchar(36) | NO | MUL |
| year | int(11) | NO | MUL |
| leave_type | enum('sick','personal','vacation','maternity','paternity','study') | NO | |
| total_days | decimal(5,2) | NO | |
| used_days | decimal(5,2) | NO | |
| remaining_days | decimal(5,2) | NO | |
| created_at | datetime | NO | |
| updated_at | datetime | NO | |

## system_logs

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| source | varchar(50) | NO | MUL |
| level | enum('info','warning','error','critical') | NO | MUL |
| code | varchar(10) | YES | MUL |
| message | text | NO | |
| details | longtext | YES | |
| ref_id | varchar(100) | YES | MUL |
| user_id | varchar(50) | YES | MUL |
| ip_address | varchar(45) | YES | |
| created_at | datetime | NO | MUL |

## auth_logs

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| employee_uid | varchar(36) | YES | MUL |
| email | varchar(100) | YES | |
| event_type | enum('login','logout','refresh','failed_login','locked') | NO | MUL |
| success | tinyint(1) | NO | |
| ip_address | varchar(45) | YES | |
| user_agent | varchar(255) | YES | |
| error_message | text | YES | |
| created_at | datetime | YES | MUL |

## refresh_tokens

| Column | Type | Null | Key |
|---|---|---|---|
| id | int(11) | NO | PRI |
| employee_uid | varchar(36) | NO | MUL |
| token | varchar(500) | NO | MUL |
| expires_at | datetime | NO | MUL |
| created_at | datetime | YES | |
| revoked_at | datetime | YES | |
| ip_address | varchar(45) | YES | |
| user_agent | varchar(255) | YES | |

The `token` column is a secret at rest. Do not log it.

## Views

`vw_attendance_daily` and `vw_monthly_report` are registered as views. Their columns could not be read because opening them hits `ERROR 1932` on `employees`.
