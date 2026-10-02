# Personnel ID onboarding design

**Status:** Dry-run design only. This does not authorize a migration or database import.

## Authority and classification

MJU Person API is the approved authoritative source for `personnelId`. A non-empty,
unique value from that source is classified as `PERSONNEL_ID_VERIFIED_FROM_MJU`.
A record without `personnelId`, from another source, or sharing the same value with
another record is `HOLD`.

`personnelId` is not automatically `employees.employee_id`. It becomes an
`employee_identifier` with the planned type `personnel_id` only after the schema
change and import are separately approved.

Current dry-run disposition:

- 34 records: `PERSONNEL_ID_VERIFIED_FROM_MJU`
- 16 records: `HOLD` because `personnelId` is missing
- 0 duplicate `personnelId` values
- no `employee_uid` is created by classification

## Identity model

The canonical identity is `employees.employee_uid`. External identifiers map to it
independently:

```text
NATIONAL_ID   ─┐
FACESCAN_ID   ─┼─> employee_uid
PERSONNEL_ID  ─┘
```

Each `(id_type, id_value)` must map to at most one `employee_uid`. Names and email
must never establish these links. Raw national IDs must not appear in logs, reports,
Git, or normal application storage; national-ID comparison remains a protected
offline operation unless a separately approved hashed/encrypted representation is
defined.

## `employees.employee_id` policy

The current schema and importer require a non-empty, unique `employee_id`. It is an
attendance employee code and natural import key, not the canonical identity.

Policy options:

1. Use an authoritative external HR employee code when the source contract
   explicitly identifies it as the employee code.
2. Otherwise allocate a controlled Attendance-local employee code from an approved
   collision-safe sequence. Record its allocation source and never derive it from
   a name, email, national ID, FaceScan ID, or `personnelId`.

Do not copy `personnelId` into `employees.employee_id` without explicit contract and
data-owner approval that both fields have the same semantics.

**Recommendation for this batch:** use option 2 because no approved external
employee-code field is available. Allocate an immutable, opaque Attendance-local
code (`RAE-` plus an eight-digit centrally controlled sequence) during the approved
batch-preparation step. Check the complete batch and target database for uniqueness
before import.
Generate `employee_uid` independently at the later approved import boundary and
never recalculate it from an employee-code change.

## Minimum schema change before import

An approved migration should:

1. Add `personnel_id` to `employee_identifier.id_type`.
2. Add a unique key on `(id_type, id_value)` so one external identifier cannot map
   to multiple employees.

The existing index on `employee_uid` remains the lookup from identifiers to the
canonical employee. No DDL is applied by this design.

Proposed DDL for review only:

```sql
ALTER TABLE employee_identifier
  MODIFY id_type ENUM(
    'facescan_id',
    'national_id',
    'employee_id',
    'personnel_id'
  ) NOT NULL,
  ADD UNIQUE KEY uk_employee_identifier_type_value (id_type, id_value);
```

Before approval, the operator must confirm that no existing `(id_type, id_value)`
maps to multiple `employee_uid` values. The current V2 runtime is empty, so the
observed conflict count is zero.
