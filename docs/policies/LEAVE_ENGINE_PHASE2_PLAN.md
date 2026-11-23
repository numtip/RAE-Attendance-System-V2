# Leave entitlement engine — Phase 2 plan (integration, precedence, schema)

> สถานะ: **แผน** ไม่มี migration ไม่มีการเขียน production และยังไม่เชื่อม engine กับ service ใด.
> Phase 1 (engine บริสุทธิ์, PR #130, `c85aeb2`): `backend/src/domain/leavePolicyEngine.js`.
> ข้อมูล HR: `HR_LEAVE_DATA_ONBOARDING.md`. กติกา: `MJU_LEAVE_POLICY_2569.md`.

## 1. หลักการ

- ตอบเป็นสถานะที่ engine ให้ (`ok / unknown / pending_policy / pending_hr_decision / needs_hr / out_of_scope / not_started`) ไม่แปลง `unknown` เป็น 0.
- เพิ่มแบบ **additive**: API/ตัวเลขที่ใช้อยู่เดิมไม่เปลี่ยนจนกว่าเจ้าของระบบจะเปิดใช้.
- ใช้ service/API/RBAC เดิม; ไม่มี endpoint ใหม่ที่ไม่ผ่าน `assertCanReadEmployee`.

## 2. สภาพปัจจุบัน (ตรวจจากโค้ดและข้อมูล 2026-11-23)

| ส่วน | พฤติกรรม |
|---|---|
| `leaveService.balance(auth, uid, year)` | `year` = ปีปฏิทิน; สิทธิ์จาก `leave_balance.total_days` (ตารางว่าง → "ไม่มีข้อมูล"); ใช้ไป = วันที่อนุมัติแล้วในปีปฏิทินนั้น (นับวันละครั้งต่อประเภท; รายการ legacy ถูกตัดถ้าทุกวันมี record แล้ว) |
| ผู้เรียก | `GET /leave/balance/:uid`, `reportService` (รายงานส่วนบุคคล + PDF), หน้า `LeaveBalanceView`, การ์ดสิทธิ์ใน `LeaveMonthlyView` |
| ข้อมูล | `employees.hire_date` มีคอลัมน์แต่ว่างทั้ง 52 คน; `leave_balance` 0 แถว; `employee_leave` 0 แถว; ช่วงนำเข้าการลาครบ 2025-10 ถึง 2026-11 (FY2569 ครบ 12/12 เดือน, FY2570 ถึง พ.ย.) |
| รหัสพนักงาน | `employee_id` 4 หลักตัวเลขล้วน ไม่มีศูนย์นำหน้า ไม่ซ้ำ (จับคู่ได้ปลอดภัยถ้าตั้งเป็นข้อความใน Excel) |

## 3. ลำดับความสำคัญของแหล่งข้อมูล และการไม่หักซ้ำ

### 3.1 สิทธิ์ (entitlement) ต่อ (พนักงาน, ปีงบประมาณ, ประเภท)

ลำดับจากสูงไปต่ำ — ใช้แหล่งแรกที่มี:

1. **แถวที่ HR รับรอง** (`employee_leave_entitlement`) — ชนะเสมอสำหรับตัวเลขสิทธิ์/ยอดยกมา. ถ้า engine คำนวณได้และต่างกัน → แสดงตัวเลขของ HR พร้อมธง `hr_differs_from_policy` (ไม่เขียนทับ ไม่ซ่อน). การมีแถว HR ถือเป็นการยืนยันสิทธิ์ของปีนั้น (ธง `eligibility_from_hr_row` เมื่อประเภทเป็น `needs_hr`); ประเภท `contract` ที่ไม่มีการยืนยัน `ใช่` ถูกปฏิเสธตั้งแต่นำเข้า.
2. **คำนวณโดย engine** เมื่อสถานะ `ok` (ต้องมีข้อมูลโปรไฟล์ครบตามกฎ).
3. **ไม่มีตัวเลข** — ส่งสถานะ + `reasons` + `missing` ตามที่ engine ให้ (`unknown`, `pending_hr_decision` พร้อม `candidates`, `pending_policy`, `needs_hr`, `out_of_scope`).

`leave_balance` เดิม (ปีปฏิทิน) **ไม่ถูกอ่านและไม่ถูกตีความใหม่** ในฐานปีงบประมาณ; ยังใช้กับคำขอฐานปีปฏิทินตามเดิมทุกประการ (ปัจจุบันว่าง). ไม่ย้ายข้อมูลระหว่างสองตาราง.

### 3.2 วันที่ใช้ (usage) — แหล่งเดียว ไม่หักซ้ำ

- ยอดใช้มาจาก **รายการลาที่อนุมัติแล้ว** เท่านั้น (`employee_leave_record` + รายการ legacy ที่ไม่ถูกครอบด้วย record ตามตรรกะ `combined()` เดิม) นับวันละครั้งต่อประเภท.
- `leave_balance.used_days/remaining_days` และ "คงเหลือ" ที่ HR ให้ **ไม่ถูกใช้เป็นยอดใช้** (HR ส่งเฉพาะสิทธิ์ — ดู onboarding §3).
- **Usage baseline** (วันที่ใช้ไปแล้วนอกระบบ): หักได้ = `usage_baseline_days` + รายการอนุมัติที่ลงวันที่ **หลัง** `usage_baseline_through`; รายการที่ลงวันที่ไม่เกินวันนั้นไม่ถูกหักซ้ำ (ธง `records_before_baseline_ignored` พร้อมจำนวน). ไม่มี baseline → หักรายการอนุมัติทั้งปีงบประมาณ.
- ข้อ 14 (วันที่ไม่นับเป็นวันลา): engine รองรับแล้ว แต่ระบบยังไม่มีที่เก็บหลักฐาน (ผู้สั่ง/เลขที่คำสั่ง) จึงยังไม่มีข้อมูลป้อนใน Phase 2 — เลื่อนไป Phase 3 (ไม่จำเป็นต่อการเปิดใช้).
- **ความครบถ้วนของข้อมูลการลา:** เดือนในปีงบประมาณที่ผ่านมาแล้วแต่ไม่มีใน `employee_leave_record_coverage` → ยอดใช้ไม่ครบ ไม่ใช่ 0; ส่ง `usageComplete: false` + `uncoveredMonths` และ `remainingDays: null` (เหตุผล `usage_coverage_incomplete`). เดือนในอนาคตไม่นับเป็นช่องว่าง.

### 3.3 ป้องกันความคลาดเคลื่อนของปีงบประมาณ

- คีย์ปีงบประมาณเก็บเป็นปี พ.ศ. ที่สิ้นสุด (`fiscal_year_be`) ในทุกตารางใหม่และทุก response; ไม่ใช้คอลัมน์ `year` เดิม.
- คำขอฐานปีงบประมาณต้องระบุชัด: `?year=2570&basis=fiscal` (ไม่ระบุ `basis` = พฤติกรรมเดิมปีปฏิทิน); `year` ที่เป็นปีปฏิทินเมื่อ `basis=fiscal` (เช่น 2026) ถูกปฏิเสธ 400 เพราะไม่ใช่ปี พ.ศ.
- ช่วงใช้ = ขอบเขตปีงบประมาณจาก `fiscalYearByBE` เท่านั้น (ไม่คำนวณซ้ำจากเดือนปฏิทิน); วันลาข้ามปีงบประมาณแยกวันทำการต่อปี (`splitLeaveByFiscalYear`).
- ป้ายหน้าจอระบุช่วงวันที่เต็ม เช่น "ปีงบประมาณ 2570 (1 ต.ค. 2569 – 30 ก.ย. 2570)".
- รายงานรายเดือน/ปีปฏิทินและการส่งออกไม่เปลี่ยน.

## 4. สัญญา API (additive)

`GET /api/v1/leave/balance/:employeeUid?year=<พ.ศ.>&basis=fiscal` — RBAC เดิม (`assertCanReadEmployee`, 403 สำหรับข้อมูลคนอื่น). แถวต่อประเภท คงฟิลด์เดิม (`totalDays, usedDays, pendingDays, remainingDays, available, unavailableReason`) และเพิ่ม:

```
basis, fiscalYear {be, start, end}, policyVersion,
status, reasons[], missing[], candidates[]|null,
source: 'hr_verified' | 'computed' | null,
kind: 'paid_leave_allowance' | 'leave_right',
overAllowanceDays, carryoverDays, usageComplete, uncoveredMonths[], flags[]
```

ฟิลด์เดิมเป็น `null` เมื่อสถานะไม่ใช่ `ok` (ผู้เรียกเดิมแสดง "ไม่มีข้อมูล" ตามที่ทำอยู่). `kind` ทำให้หน้าจอแยก "วงเงินวันลาที่ได้รับค่าจ้าง" (ลาป่วย/ลากิจ) ออกจาก "สิทธิ์ลา" (ลาพักผ่อน) — ไม่ใช้คำว่าขาดงาน.

## 5. ช่องว่างของสคีมา (เฉพาะที่จำเป็น) และข้อเสนอ migration

ไม่ต้องแก้: `employees.hire_date` (มีแล้ว, DATE NULL), `leave_balance` (คงเดิมเป็น legacy), `employee_leave_record`, `employee_leave_record_coverage`, `employee_assignment`, `attendance_holiday` (ช่องว่างเป็นเรื่องข้อมูล ไม่ใช่สคีมา; จำเป็นเฉพาะการนับวันทำการจากช่วงวันที่ — รายการลาเป็นรายวันอยู่แล้วจึงไม่จำเป็นต่อยอดคงเหลือ).

| ลำดับ | ไฟล์ที่เสนอ | ทำไมจำเป็น |
|---|---|---|
| 034 | `employee_leave_profile` | เก็บข้อเท็จจริงรายคนที่ไม่มีที่เก็บ: `continuous_service_start` (ข้อ 62), `appointment_kind` (ข้อ 23), การยืนยันสิทธิ์ + เลขที่อ้างอิง, ผู้ยืนยัน/เวลา. ไม่ใส่ใน `employees` เพื่อไม่ปนข้อมูล HR ที่ต้องตรวจสอบย้อนกลับกับตารางโปรไฟล์/สิทธิ์เข้าใช้ |
| 035 | `employee_leave_entitlement` | สิทธิ์ที่ HR รับรอง ต่อ (คน, `fiscal_year_be`, ประเภท): `entitlement_days`, `carryover_days`, `usage_baseline_days/through`, `source_reference`, `import_batch_uid`, ผู้ยืนยัน/เวลา; `UNIQUE(employee_uid, fiscal_year_be, leave_type)`; CHECK ให้ยกมาเฉพาะลาพักผ่อน และ baseline ต้องมาเป็นคู่ |
| 036 | `employee_leave_hr_audit` (+ แบตช์) | บันทึกก่อน/หลังต่อฟิลด์และแบตช์นำเข้า (SHA-256, จำนวนแถว, ผู้รัน) ตามแบบ `employee_leave_record_audit` — จำเป็นต่อการนำเข้าซ้ำแบบ idempotent และการตรวจสอบย้อนหลัง |

ทุกไฟล์ additive + idempotent (guard แบบ migration 022), มี rollback ใน `database/rollbacks/` ที่ปฏิเสธเมื่อมีข้อมูล (แบบ 032), ใช้ `DECIMAL(4,1)` และ `SMALLINT` สำหรับปี พ.ศ.; **ไม่ได้เขียนไฟล์เหล่านี้ในรอบนี้** — ต้องมีอนุมัติ migration แยก และใช้ตารางเฉพาะเมื่อ deploy.

## 6. แผนการเชื่อมระบบ (ลำดับ PR)

| PR | เนื้อหา | ต้อง migration | เปลี่ยนพฤติกรรมผู้ใช้ |
|---|---|---|---|
| 2a | repository (MariaDB + fixture) สำหรับ profile/entitlement, `employees.updateHireDate`; unit test ด้วย fixture | เขียนไฟล์ 034–036 | ไม่ |
| 2b | `leaveEntitlementService` (บางๆ): ประกอบข้อเท็จจริง (employees + profile) + records + coverage + แถว HR → `computeEntitlements` → ผสานตาม §3 → รูปแบบแถวเดิม+ฟิลด์ใหม่. `leaveService.balance` เรียกเมื่อ `basis=fiscal` เท่านั้น. flag `LEAVE_ENTITLEMENT_ENGINE=off\|shadow\|on` (ค่าเริ่มต้น `off`) | ไม่ | ไม่ (flag off) |
| 2c | `leave:import-hr-data` (dry-run → `--confirm`) ตาม onboarding §5 | ใช้ 034–036 | ไม่ |
| 2d | โหมด `shadow`: คำนวณเทียบกับพฤติกรรมเดิมแล้วบันทึกเฉพาะจำนวนต่อสถานะ (ไม่มีข้อมูลส่วนบุคคล) | ไม่ | ไม่ |
| 2e | UI: การ์ด/หน้า "วันลาคงเหลือ" ปีงบประมาณ + ป้ายสถานะภาษาไทย (`รอ HR ยืนยัน`, `รอการตัดสินของ HR`, `ไม่มีข้อมูล`, `รอนโยบาย`); รายงานส่วนบุคคลสลับฐานเมื่อเจ้าของระบบอนุมัติ | ไม่ | ใช่ (เมื่อ flag on) |

ภาพรวมระดับกอง/องค์กรที่ต้องการยอดคงเหลือหลายคน ต้องเป็น endpoint รวมฝั่งเซิร์ฟเวอร์ (ห้ามเรียกต่อคนจากหน้าเว็บ ตามที่แก้ N+1 แล้วใน #129) — นอกขอบเขต Phase 2.

## 7. Acceptance tests ของ Phase 2

- ลำดับความสำคัญ: แถว HR ชนะค่าคำนวณ + ธง `hr_differs_from_policy`; ไม่มีแถว HR + engine `ok` → `computed`; engine `unknown` → ไม่มีตัวเลข.
- ไม่หักซ้ำ: record ลงวันที่ ≤ `usage_baseline_through` ไม่ถูกหัก; legacy + record วันเดียวกันหักครั้งเดียว; `leave_balance.used_days` ไม่ถูกอ่าน.
- ปีงบประมาณ: `year=2026&basis=fiscal` → 400; 2569 → `pending_policy`; 2570 → ขอบเขต 2026-10-01..2027-09-30; ไม่มี `basis` → ผลเดิมทุกไบต์ (golden).
- ความครบถ้วน: เดือนที่ผ่านแล้วไม่อยู่ใน coverage → `usageComplete:false`, `remainingDays:null`.
- `needs_hr` / `out_of_scope` → ไม่มีตัวเลข; มีแถว HR ยืนยัน → ตัวเลขพร้อมธง.
- RBAC: พนักงานทั่วไปขอข้อมูลผู้อื่น → 403; ผู้จัดการเห็นเฉพาะขอบเขตตน.
- การส่งออก PDF/XLSX และรายงานรายเดือนเดิมไม่เปลี่ยน; ไม่มี N+1 (นับจำนวนคำขอ).
- นำเข้า HR: ทุกกติกาใน onboarding §4; นำเข้าไฟล์เดิมซ้ำ = ไม่ทำอะไร; เซลล์ว่างไม่เขียนทับ; output ไม่มีรหัส/ชื่อ.
