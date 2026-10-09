# Data import validation

Dry-run checks implemented in `scripts/data-onboarding/lib.mjs`. They run on a JSON file. They do not open MariaDB.

## Gates

| Code | Table | Rule |
|---|---|---|
| `REQUIRED` | employees, identifiers, leave, balances | Missing natural key or required text |
| `DUPLICATE_EMPLOYEE_ID` | employees | Same `employee_id` twice |
| `DUPLICATE_EMAIL` | employees | Same email twice after lowercase |
| `INVALID_ENUM` | employees, identifiers, attendance, leave, balances | Value outside the V2 enum |
| `INVALID_DATE` | employees, attendance, monthly, leave | Impossible or non-ISO date, or month/year out of range |
| `SECRET_PRESENT` | employees, staging_leave | `password_hash`, `national_id_encrypted`, or `raw_data` included |
| `INVALID_FORMAT` | employee_identifier | `national_id` not 13 digits |
| `UNKNOWN_EMPLOYEE` | identifier, monthly, leave, balance | No matching employee in the same file |
| `ORPHAN_ATTENDANCE` | daily_attendance | `employee_id` not in the employee set |
| `DUPLICATE_IDENTIFIER` | employee_identifier | Same `id_type` + `id_value` |
| `OVERLAP` | daily_attendance, staging_leave | Same employee-day, or leave ranges that overlap |
| `INVALID_RANGE` | attendance, leave | End before start |
| `BALANCE_MISMATCH` | leave_balance | `remaining_days` differs from `total_days - used_days` |
| `ROW_COUNT` | reconcile | Dry-run row count differs from the expected sheet |
| `CHECKSUM` | reconcile | Plan checksum differs |
| `VALIDATION` | reconcile | Expected a valid file and the file is not valid |

## Row counts and checksum

`import-dry-run.mjs` prints `plan.<table>.rows` and a `checksum` of the insert/skip plan. `reconcile.mjs` compares that report to an expected JSON document:

```json
{
  "requireValid": true,
  "checksum": "<checksum from the approved dry-run>",
  "tables": {
    "employees": { "rows": 0 }
  }
}
```

The synthetic sample's counts are covered by `scripts/data-onboarding/onboarding.test.mjs`. Do not paste real row extracts into git.

## What validation does not prove

- That any legacy table still has readable rows (`ERROR 1932` remains a separate problem).
- That `employee_id` values match an HR system. No HR source is named.
- That monthly totals equal the sum of daily rows. The checker does not recompute them.
- That a later SQL load succeeded. There is no production writer in this change.
