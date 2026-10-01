# Authorization model

SSO and password login prove identity. They do not grant data scope. Every employees, attendance, and leave read checks scope on the server. Hiding a control in the SPA is not a control.

## Roles

| Role | Directory (employees) | Attendance and leave |
|---|---|---|
| `EMPLOYEE` | Self only | Self only |
| `MANAGER` | Self, plus employees in org-unit codes granted to that manager | Same |
| `EXECUTIVE` | Organization-wide only when an `organization` grant exists for that person | Same |
| `ADMIN` | All employee rows | Self only, unless a separate data grant exists. Admin is not an executive. |

Stored legacy values still map: `admin` → `ADMIN`, `manager` → `MANAGER`, `user` → `EMPLOYEE`. Unknown values are treated as `EMPLOYEE`.

A caller who is authenticated but outside scope receives **403** `FORBIDDEN`. A missing row inside scope is **404**.

`employee_id` in a query string does not select a different person. The path `employee_uid` is the record. If `employeeId` is present and does not match that row, the response is 403.

## What the schema actually has

`employees.department` is a string. `employees.role` is `admin`, `manager`, or `user`. There is no org-unit table, no parent unit, and no manager assignment in migrations 001–010.

Because of that, manager scope is **not** “everyone in the same department” and executive scope is **not** automatic. Migration `011_authorization_scope.sql` adds:

- `employee_org_membership(employee_uid, org_unit_code)` — an opaque code, not a department name
- `authorization_grants(employee_uid, role, scope_type, org_unit_code)` — `self`, `org_unit`, or `organization`

No unit names are seeded. A code is valid only when an evidenced import supplies it. Until a grant exists, a manager or executive sees self only.

## Enforcement

`backend/src/services/authorizationService.js` resolves the JWT `employeeUid` and role. Repositories then return rows, and the service drops anything outside the resolved set. Daily attendance for a whole date is rejected with 403 unless the caller has an organization grant or at least one org-unit grant.

The SPA may hide a control. That is UX. The review fixture refuses another person's attendance and leave with 403 and does not treat `admin` or `manager` as organization-wide access. Legacy bundle checks (`isAdmin`, `isManager`) are not security.
