# Identity kind mapping: MJU / HIP / UNRESOLVED

**Status:** code + synthetic tests only. No production import, migration, deploy or SSH. Real `database/IDCardRaecsv2027.csv` is gitignored, read-only and never rewritten.

## Rules (user-confirmed)
1. `IDCardRaecsv2027.csv` is the primary list: 52 rows = **50 unique people** (2 exact duplicate rows collapse; nobody is dropped).
2. A person with an MJU `personnel_id` uses the **MJU** identity mapping.
3. A contractor with no MJU data uses the CSV **HIP id** (CSV column `Facescan Code` = HIP/FaceScan USERID = `facescan_id`) as the identity reference. **No `personnel_id` is ever invented.**
4. MJU and HIP are separate namespaces; collisions are blocked.
5. MJU SSO is not required for contractors and no SSO subject is created by onboarding.
6. National ID follows the PR #30 contract (HMAC + key version, raw storage disabled, no name-only matching).

> Assumption to confirm: "ID Hip" in the request is the CSV `Facescan Code` column (the CSV has only `ID card Code`, `Facescan Code`, `name`, unit; docs define HIP `facescan_id` = FaceScan USERID).

## Model (no schema change)
| Kind | Primary reference | Identifier rows (`employee_identifier`) | SSO |
|---|---|---|---|
| MJU | `personnel_id` (`source_system='mju_person_api'`) | `personnel_id` + `national_id` (HMAC) + `facescan_id` (`IDCardRaecsv2027`) | optional; link only from a verified MJU SSO callback |
| HIP | `facescan_id` (`source_system='IDCardRaecsv2027'`) | `facescan_id` (primary) + `national_id` (HMAC, for de-dup and a later MJU match) | not required, no subject created |
| UNRESOLVED | none | nothing staged | n/a |

The kind is **derived** from active identifiers (`backend/src/domain/identityKind.js`, `service.getIdentityKind(uid)`), so it cannot drift from the data. A `personnel_id` whose source is not `mju_person_api` makes the employee `UNRESOLVED` with violation `PERSONNEL_ID_NOT_FROM_MJU`. Upgrade path: when an MJU account appears, attach an MJU `personnel_id` to the **same** `employee_uid` (kind becomes MJU, the HIP id stays the attendance source).

## Collision protection
- `UNIQUE(id_type, id_value)` already stops the same HIP id or personnel_id on two employees; resolution is always typed (`resolve('facescan_id', x)` never falls back to `personnel_id`).
- New in `linkIdentifier`: the same text in the other namespace (`facescan_id` vs `personnel_id`) for a **different** employee is refused (409 `IDENTIFIER_NAMESPACE_COLLISION`); the same employee may hold equal text in both.
- New: `personnel_id` can only be linked with `sourceSystem='mju_person_api'` (400 `PERSONNEL_ID_SOURCE_REQUIRED`).
- Mapping tool holds (UNRESOLVED) rows with: invalid/failed-checksum National ID, missing/invalid HIP id, one national with two HIP ids, one HIP id shared by two nationals, HIP id equal to someone else's personnel_id (MJU source or DB), HIP id already assigned to another employee, conflicting existing identifiers, ambiguous or duplicate MJU matches.

## Classification gates
- **MJU** needs exactly one match by protected National ID lookup (current + previous key) against an **authoritative** MJU source. Names/e-mail never match.
- **HIP** needs no MJU match **and** `--hip-approval-ref` **and** either an authoritative MJU source (negative result) or explicit `--accept-unverified-mju-absence` (recorded as basis `OPERATOR_CONFIRMED_NO_MJU_ACCOUNT`).
- Everything else stays in the list as UNRESOLVED with a reason; counts always add up to the unique rows.

## Run (dry-run, masked, nothing written)
```
node scripts/data-onboarding/map-idcard-identity-kinds.mjs --csv database/IDCardRaecsv2027.csv --summary [--mju-source private.json] [--existing snapshot.json] [--hip-approval-ref REF] [--accept-unverified-mju-absence]
```
Needs `EMPLOYEE_IDENTIFIER_HMAC_KEY[_FILE]`; `--ephemeral-key` uses a throw-away in-memory key for counts only. Output: counts, reasons, masked `****NNNN` items — never raw National ID, HIP id or personnel_id.

## Not done / gates still closed
MJU authoritative source, employee scope and VPS gate remain BLOCKED; no production migration/import/deploy. Staged identifiers (`staged`) exist only in memory for a future, separately approved import.
