# NEXT STEPS — from 2026-10-20

**Current gate:** `EMPLOYEE_MASTER_SCHEMA_RESOLUTION`
**Then:** `MARIA_DB_REHEARSAL`
**Production:** FROZEN — no import, migration, deploy or SSO activation until the gate clears.

Attendance evidence needs **no further work**. Everything below is either an owner decision or a
verification step.

---

## 1. First task — close the employee schema gate (F1–F4)

These four are proven mechanically, not opinions: a rehearsal of the schema **exactly as written** rejected
the import with `NOT NULL constraint failed: employees.email` and **0 rows committed**. Rows unable to
satisfy: email 54, surname 54, employee_type 54, employee_uid 54.

| Order | Decision needed | Owner must supply |
|---|---|---|
| 1 | `employees.email` — `NOT NULL UNIQUE`, no source anywhere | real addresses, **or** approve a documented placeholder policy / schema change |
| 2 | Name handling — the workbook has **one** name field | approve a split rule, **or** move to a single name field (Chinese/Thai surname splitting must not be guessed) |
| 3 | `employee_type` — `NOT NULL` enum (`university`/`department`/`contract`) | the value per person |
| 4 | `employee_uid` — UUID, immutable, never derived from an identifier | approve an allocation policy (UUIDv4 at import) |

Do **not** invent any of these values to unblock the rehearsal. That is the exact over-claim the gate exists to prevent.

## 2. Second task — close the methodology caveat (F7)

Re-run the existing harness against a **disposable MariaDB** (no Docker on this workstation, so use a
local MariaDB or the WSL instance already known to the project):

```
python scripts/data-recovery/rehearse_fy2569_import.py
```

Confirm on the real engine: `ENUM` values accepted, `CHECK` constraints enforced, FK on
`employee_identifier` rejects an unknown `employee_uid`, and — importantly — **`daily_attendance` still
accepts an orphan**, because `004_daily_attendance.sql` declares no FK. Do not add one to make a test pass.

## 3. Third task — resolve the two open conflicts

1. **Identity bases.** Decide whether the 19 codes excluded on 2026-10-19 (absent from `dataperson.csv`,
   which is **no longer on disk**) stay excluded, now that the 2026-10-20 owner master covers **all 54** HIP
   codes with **0** foreign codes.
2. **24 / 25 / 26.** Determine which single person-month is in the register but not observable in
   `monthly_summary.csv`, or record that the 24 figure was computed over a narrower month set. Until then
   quote all three with their definitions, never one as "the" count.

## 4. Then, and only then

Proceed to a VPS-A recovery review under a **separate approval** that includes a rollback plan. VPS-A's
`attendance_db` remains unreadable (InnoDB error 1932, orphaned tablespaces) and this session made **no
attempt** to recover it.

---

## Do not do

* Push to `main` outside an approved closeout, merge any PR, or open a VPS session.
* Write any production database, or apply migrations to a host.
* Commit the owner workbook, `database/IDCardRaecsv2027.csv`, `database/local/**`, or any raw HIP export.
* Enable SSO or the mock-free production path.
* Create a synthetic `employee_uid`, `personnel_id` or `sso_subject` to make a dataset look complete.
* Re-derive an identity by name. Codes only; national ID joins use the HMAC contract.
