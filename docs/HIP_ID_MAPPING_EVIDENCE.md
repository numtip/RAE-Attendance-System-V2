# Evidence: CSV `Facescan Code` = HIP ID (`facescan_id`)

**Status: DOCUMENTED, NOT VERIFIED AGAINST A REAL HIP EXPORT.** Tooling treats it as unverified until an evidence reference is supplied (`--hip-id-evidence-ref` / `hipPolicy.hipIdFieldEvidenceRef`). Without it no row becomes HIP and no HIP id is attached as an attendance source (`HIP_ID_FIELD_UNVERIFIED`).

## What the repository proves
| Evidence | Where | Says |
|---|---|---|
| Identity contract | `docs/IDENTITY_CONTRACT.md` lines 39, 49, 120 | `facescan_id` = "HIP / FaceScan USERID"; FaceScan USERID maps to `employee_identifier.id_value` with `id_type='facescan_id'` |
| Raw ingestion design | `docs/FACESCAN_RAW_INGESTION.md` line 8 | `HIP facescan_id (USERID)` |
| Phase-A ingestion branch (`feat/facescan-ingestion-phase-a`, `00b92c5`, not in this branch) | `docs/FACESCAN_INGESTION.md` lines 11, 17, 61; `backend/src/domain/facescanIngestion.js` | HIP `USERINFO.USERID` = FaceScan external id; `CHECKINOUT.USERID -> employee_identifier.facescan_id -> employee_uid` (ingestion also reads `Badgenumber` as separate metadata) |
| Schema | `database/migrations/013_employee_identifier_foundation.sql` | `id_type ENUM(... 'facescan_id' ...)`, `UNIQUE(id_type,id_value)` |
| CSV header (read-only, bytes checked) | `database/IDCardRaecsv2027.csv` (gitignored) | columns `ID card Code`, `Facescan Code`, name, unit; 52 rows, 50 unique; every code is a 4-digit value, unique per person |
| Import plan | `docs/IDCardRaecsv2027_IMPORT_PLAN.md` line 23 | maps "FaceScan / HIP" to `facescan_id` |

## What it does NOT prove (why production use is gated)
1. No HIP `USERINFO`/`CHECKINOUT` export is available in the repository or workspace, so nothing shows that the CSV codes equal `USERID` (and not `Badgenumber` or a card number).
2. Documentation is design intent, written before any real HIP data was compared.
3. Obtaining a real export needs the VPS/HIP read-only access gate (SSH), which is closed.

## Verification procedure (needs approval; read-only, masked)
1. Operator exports HIP `USERINFO` (`USERID`, `Badgenumber`, no names) through the approved channel into the private batch directory (never into Git).
2. Run a masked comparison: how many of the 50 CSV codes exist as `USERID`, how many as `Badgenumber`, how many in both/neither, and whether any CSV code maps to a different HIP person than the one the National ID/name column suggests (compare in the private environment, report counts only).
3. Pass criteria: 50/50 found as `USERID`, 0 found only as `Badgenumber`, 0 conflicts. Anything else => keep `HIP_ID_FIELD_UNVERIFIED`.
4. Record the evidence reference (ticket/checksum of the private comparison report, no PII) and pass it to the mapping tool.

## Rules that stay in force
`Facescan Code` is never used as `personnel_id`; MJU `personnel_id` and HIP `facescan_id` are separate namespaces (migration 017 + service guard); scope is the 50 confirmed unique employees (the earlier "34" is retired; remaining `34` mentions in tests are synthetic fixture arithmetic).
