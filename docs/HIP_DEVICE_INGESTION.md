# HIP CMi681S — device ingestion preflight

**Status:** research only (read-only). No collector is implemented and no device protocol is used yet.
Companion to [`FACESCAN_RAW_INGESTION.md`](./FACESCAN_RAW_INGESTION.md), which defines the app-side
staging path this collector would feed.

Labels used below: **VERIFIED** = read in vendor manual / product page / our own live check ·
**REPORTED** = vendor or dealer list says so, not independently confirmed · **INFERRED** = reasoned
from adjacent evidence · **UNKNOWN** = not established.

## 1. Model identity

The project name "CMi F681S" does not exist in the vendor catalogue; three different strings appear.

| String | What it is | Evidence |
|--------|-----------|----------|
| `CMi681S` | Fingerprint terminal (face capacity: none), 6,000 fingers, 160,000 records, TCP/IP + USB + U-disk | **VERIFIED** — `hip.co.th` product page, `CMI-681S` manual rev. 01 (Dec 2015) |
| `CMiF681S` | Appears only inside vendor *supported-model lists*; no product page, no manual, no datasheet | **REPORTED** — `hip.co.th/download-center`, `hip-servicecenter.com/newpro/download.php` |
| `CMiF68S` | Face + fingerprint terminal (1,000 faces / 5,000 fingers), same 160,000 records | **VERIFIED** — dealer spec page + vendor manual |

The operator confirmed the unit at `10.1.7.201` is a **CMi681S** (fingerprint, Series 8 family).
Anything downstream must therefore not assume face templates; only the `facescan_id` value space is used,
which is why the field name in `staging_facescan_raw` stays as-is.

## 2. Network evidence (measured 2026-10-19, from VPS 10.1.254.237)

| Check | Result | Label |
|-------|--------|-------|
| Route to device | `via 10.1.254.254 dev ens160 src 10.1.254.237` (different subnet, routed — no L2 adjacency) | **VERIFIED** |
| ICMP | 3/3 replies, 0% loss, 0.58–7.03 ms | **VERIFIED** |
| TCP `5005` | connect succeeded, 23 ms, **OPEN** (single connect, no payload, no login) | **VERIFIED** |

The port test proves only that *something* accepts TCP/5005. It does **not** prove the service is the
vendor data-pull endpoint, nor that we may read from it.

## 3. Ports and direction

| Port | Direction | Meaning | Label |
|------|-----------|---------|-------|
| **5005** | client → device | Device service port, **Series 8 family default** | **VERIFIED** — *"หมายเลข Port ของเครื่องตระกูล Series 8 = 5005"* (Premium Time Series 8/U manual §1.9) |
| 5500 | client → device | Same, Series U family | **VERIFIED** — same section |
| 7005 / 7006 | device → server | The **server** port the device pushes to (HIPezTIME / SyncTime Cloud); not a device service | **VERIFIED** — HIPezTIME manual: *"Server port กำหนดค่า 7005 หรือ 7006"* |

Consequence: 7005/7006 are listener ports we would have to host, and configuring them means changing the
device. 5005 is the device-side port a collector would connect to.

## 4. Ingestion options

| Path | Mechanism | Blockers | Verdict |
|------|-----------|----------|---------|
| **A. Text log / CSV export** | Export from HIP Premium Time, import file | Manual export step; fixed column set; batch, not incremental | **already the live path** — see `FACESCAN_RAW_INGESTION.md` |
| **B. Read-only DB read** | Copy the Premium Time database (`…\DB\PM2014`) and read the copy | File type / schema **UNKNOWN**; must never open the live file (locking); schema may change on vendor upgrade | viable after schema is known |
| **C. SDK over TCP 5005** | Vendor SDK pulls punches directly | **No public SDK or protocol document exists**; requires vendor agreement/licence; port open ≠ protocol known | **blocked** |

Ranking: A now, B as enrichment when the schema is documented, C only if the vendor supplies an SDK and
licence. A is also the only path that needs no device change and no new inbound port.

## 5. Vendor software compatibility (for this model)

| Package | Supports CMi681S | Label |
|---------|------------------|-------|
| HIP Premium Time for Series 8 **2.0.4 (2022 build)** | yes — recommended | **VERIFIED** |
| HIP Premium Time for Series 8 2.0.4 (2016 / legacy build) | yes | **VERIFIED** |
| HIP Premium Time for Series 8 **2.0.6 (2026)** | **no** (only CiF91S-VL, CiF93S-VL, CiF95S-VL, CMiF95S-VL, CiF263-VL, CMiF68S Plus) | **VERIFIED** |
| HIP TIME 4.0 ("Series S") | listed as `CMi 681S / CMi 681S NEW` — contradicts the Series 8 manuals | **REPORTED (conflicting)** |
| HIPezTIME (Series S and U) | no model list published | **UNKNOWN** |

Do not upgrade the operator's install to 2.0.6 without checking this table.

## 6. Collector seam

No new pipeline is needed. `ingestBatch(batchId, rawRows)` already accepts raw rows, so an interchangeable
source only has to **produce those rows** (`facescan_id`, `scan_datetime`, `scan_type`). That keeps the
identity flow, idempotency key and staging tables untouched.

```text
HIP device / vendor export
        │  (one of the three paths in §4)
        ▼
  collector adapter  ──►  rawRows[{ facescan_id, scan_datetime, scan_type }]
        │
        ▼
  facescanRawIngestion.ingestBatch(batchId, rawRows)   ← existing, unchanged
```

Adapter contract (proposed, one file, three implementations):

- `csvExport` — reads exported report files (**active**)
- `readOnlyDb` — reads a copy of the vendor database (**blocked on schema**)
- `vendorSdk` — TCP 5005 via vendor SDK (**blocked on vendor agreement**)

A collector that cannot reach its source must **fail loudly**; returning an empty list is forbidden,
because an empty batch is indistinguishable from "no punches today".

## 7. QA gates before any collector is trusted

1. Row count must equal the vendor software's own count for the same period
   (the vendor manual prescribes this comparison: `records imported == All Log in text file`).
2. Re-importing the same file yields zero new rows (existing `idempotency_key`).
3. `scan_type` mapping verified against a sample where in/out are known.
4. Timezone and Buddhist-era conversion covered by tests (existing `parse_date_thai` helpers).
5. Output contains only `facescan_id`, timestamps and scan type — no face images, no fingerprints, no national IDs.
6. Collector failure raises; it never silently produces an empty batch.

## 8. Open blockers and vendor questions

Blockers:

1. Vendor model string mismatch makes manual/port selection error-prone (§1).
2. No public SDK or protocol document → path C cannot start (§4).
3. Vendor database format undocumented → path B cannot start (§4).

Questions for the HIP dealer/support:

1. Confirm the installed unit's exact model and family (CMi681S, Series 8?).
2. Is there an SDK (Windows or Linux) for reading data over TCP 5005, with protocol documentation, and
   under what licence/cost?
3. What is the exact export file format (columns, encoding, delimiter) from Premium Time, and is it documented?
4. Are the files in the USB `Log data` folder encrypted, and can they be decrypted without Windows?
5. What is `DB\PM2014` (Access / SQLite / SQL Server), can it be read read-only while the software runs,
   and is there a data dictionary?
6. Please provide a screenshot of `MENU > ตั้งค่า > Network` (IP and port as configured) — view only, no edits.
7. Does HIPezTIME / SyncTime Cloud expose a read-only way to pull punches?

## 9. Sources

- `https://www.hip.co.th/product/hip-fingerprint-cmi681s/` — model spec, supported software
- `https://www.hip.co.th/download-center/` and `https://hip-servicecenter.com/newpro/download.php` — supported-model lists, manual links
- `CMI-681S` user manual rev. 01 (2015-12-24), vendor PDF — LAN pull setup, port/IP pairing
- `HIP Premium Time Series 8 and Series U` manual, vendor PDF — §1.9 device port 5005 / 5500, port-forwarding example
- `HIPezTIME` manual, vendor PDF — device push to server port 7005 / 7006
- Live checks on VPS `10.1.254.237`, 2026-10-19: `ip route get`, bounded ICMP, single TCP connect to 5005
