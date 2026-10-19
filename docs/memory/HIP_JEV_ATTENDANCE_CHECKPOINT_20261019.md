# HIP CMi F681S + Cursor Agent / REA / Jev + Attendance V2 — checkpoint

**บันทึกเมื่อ:** 2026-10-19  
**ประเภท:** เอกสารสรุปและ handoff เท่านั้น  
**ขอบเขต:** ไม่เปลี่ยนโค้ด production, ไม่ apply migration, ไม่เชื่อมต่อหรือดึงข้อมูลจากเครื่องจริงในการจัดทำ checkpoint นี้

## วิธีอ่านสถานะหลักฐาน

- **ยืนยันใน repo** — มีเอกสารหรือสถานะใน `main` รองรับ ณ วันที่ตรวจ
- **รายงานในบทสนทนา** — มีผลหรือข้อสรุปถูกส่งไว้ในบทสนทนาอ้างอิง แต่ไม่ได้ทำซ้ำในการจัดทำเอกสารนี้
- **ต้องตรวจสอบ** — หลักฐานปัจจุบันยังไม่พอให้ยืนยัน

ข้อมูลในไฟล์นี้ผ่านการคัดออกเพื่อไม่บันทึก secrets, credentials, PII, network endpoint, raw logs หรือ biometric data

## สรุป checkpoint

1. **HIP:** คู่มือยืนยันว่าซอฟต์แวร์ HIP Premium Time มี workflow ดาวน์โหลด Log และบันทึกเป็น Text ได้ แต่ยังไม่ยืนยันรุ่นจริงว่าเป็น CMi F681S หรือ family ใด และยังไม่มีหลักฐานพอสำหรับเขียน client เชื่อมต่อโปรโตคอลของเครื่องโดยตรง
2. **Cursor Agent / REA / Jev:** บทสนทนารายงานว่า Jev ตอบผ่าน live smoke ได้ก่อนการแก้ metadata; การแก้ metadata ผ่าน offline tests แล้ว แต่ live smoke หลังแก้ยังเป็น gate ที่ต้องปิดโดยผู้ปฏิบัติงานตามขั้นตอนอนุมัติ
3. **Attendance V2:** เอกสารใน `main` ระบุว่า FaceScan Phase A (staging, batch และ idempotency) มีใน application code; migration 014 ยังไม่ apply และ Phase B ที่แปลง raw rows เป็น daily attendance ยังไม่เริ่ม
4. **ขอบเขต:** ผล TCP connect หรือ live Jev smoke ไม่ได้ยืนยันการอ่าน Log จากเครื่อง HIP, การ ingest เข้า Attendance V2, หรือความพร้อมใช้งาน production

## 1. HIP CMi และการดึง Log

### ยืนยันจากคู่มือ

- คู่มือ HIP Premium Time อธิบายการเชื่อมต่อหลายแบบ รวม TCP/IP และแสดงวิธีดาวน์โหลดข้อมูลเวลาเข้าฐานข้อมูลของโปรแกรม
- โปรแกรมมีตัวเลือกดาวน์โหลดข้อมูลแบบรายการใหม่ (`NEW`) หรือทั้งหมด (`ALL`) และมีตัวเลือก `Save Download Log` เพื่อบันทึก Log เป็นไฟล์ Text ตามวัน/เวลาที่ดาวน์โหลดเมื่อเปิดใช้งาน
- มีเมนูนำเข้า Log ที่มีอยู่แล้ว และเมนูสำรองฐานข้อมูล `Pm2014.mdb`
- เอกสารคู่มือที่ตรวจไม่ได้ระบุรุ่น CMi F681S โดยตรง ส่วน KB อ้างอิงภายในที่ตรวจใช้ชื่อ CMi F68S ซึ่งไม่ตรงกับชื่อรุ่นในคำขอนี้ จึงไม่ควรถือว่าสองชื่อนี้เหมือนกันหรือสรุป family จากชื่อเพียงอย่างเดียว
- ค่า IP และ port ในตัวอย่างของคู่มือเป็นตัวอย่าง ไม่ใช่ค่าที่ยืนยันของเครื่องเป้าหมาย

### รายงานจากบทสนทนา

- มีรายงานการเปิด TCP connection ไปยัง endpoint ที่ระบุในบทสนทนาได้สำเร็จหนึ่งครั้ง
- การทดสอบนั้นไม่ได้ส่ง application payload, อ่าน banner, ยืนยันชนิดบริการ, หรือทดสอบการดึง Log และไม่ใช่หลักฐานว่า endpoint เป็นเครื่อง HIP
- รายละเอียด endpoint และข้อมูลเครือข่ายถูกละไว้จาก checkpoint สาธารณะ

### ยังต้องตรวจสอบ

- รุ่นที่ป้ายเครื่องและ family/firmware ที่ตรงกับคู่มือ รวมถึงค่าการเชื่อมต่อที่ผู้ดูแลตั้งไว้จริง
- วิธีที่ได้รับอนุญาตให้ดึง Log จาก HIP Premium Time และตัวอย่างไฟล์ที่ตัดข้อมูลระบุตัวบุคคลออกแล้ว
- encoding, schema, รูปแบบวันเวลา, timezone, scan type และกติกาการจัดการรายการซ้ำ/ข้อมูลแก้ไขของไฟล์จริง
- SDK หรือ protocol ระดับ application สำหรับการเชื่อมต่อเครื่องโดยตรง หากจำเป็นต้องพัฒนาเส้นทางนี้

**แนวทางปลอดภัยสำหรับขั้นถัดไป:** เริ่มจาก workflow ใน HIP Premium Time ที่คู่มือระบุ แล้วตรวจไฟล์ตัวอย่างที่ผ่านการลบ PII ก่อนออกแบบ importer; อย่าสมมติว่า TCP connect เพียงอย่างเดียวแปลว่าอ่าน Log ได้

## 2. Cursor Agent / REA / Jev

### ยืนยันจากเอกสาร repo

- สถาปัตยกรรม Attendance V2 ระบุเส้นทาง agent เป็น Cursor/cloud agent/script → adapter ใน `agent/` → shared Agent Core ผ่าน HTTPS `/v1/decision`; policy และ routing ของ Jev/OpenRouter อยู่นอก repo นี้
- Express API ของ Attendance V2 ไม่ได้ import `agent/` ขณะ runtime

### รายงานจากบทสนทนา

- ก่อนการแก้ metadata มี live Jev smoke ที่รายงาน HTTP 200 จากหนึ่ง request และได้รับผล Decisions จริง ไม่ใช่ fallback
- พบและแก้ปัญหา offline ที่ response normalizer ทำ upstream model/provider metadata หายระหว่างทาง โดยรักษา transport provider แยกจาก upstream metadata
- รายงานระบุว่า Agent tests ผ่าน 62/62 และ secret scan ผ่าน; ไม่ได้ทำซ้ำการทดสอบเหล่านี้ใน checkpoint นี้
- หลังการแก้ยังต้องมี operator-approved single-request smoke ใหม่เพื่อยืนยัน metadata บนผล `decide()` และปิด gate `LOCAL_JEV_LIVE_SMOKE_2_PASS`; ในรายงานเดิมยังไม่มีการรันซ้ำ live หลังแก้

### ยังต้องตรวจสอบ

- ผล live smoke หลังการแก้ metadata และค่าที่ส่งกลับ โดยบันทึกเฉพาะผลที่ไม่เปิดเผยข้อมูลลับ
- ความหมาย/ขอบเขตของคำว่า “REA” ในบริบทนี้ หากจะใช้เป็นชื่อ component หรือระบบในเอกสารเชิงเทคนิค

**ขอบเขตความรับผิดชอบ:** ใช้ Cursor Agent เป็นผู้ปฏิบัติงานตามงานที่กำหนด; การตัดสินใจด้านสถาปัตยกรรม, การผสานงาน, QA และการยอมรับผลยังเป็นของผู้ดูแลโครงการ

## 3. Attendance V2 และสถานะ FaceScan

### ยืนยันจาก repo ณ `main`

- `docs/FACESCAN_RAW_INGESTION.md` อธิบาย Phase A: staging, batch ingestion, idempotency และการ resolve HIP `facescan_id` ไป `employee_uid`
- migration `014_facescan_raw_ingestion.sql` ยังไม่ apply ตามเอกสาร; การ apply ต้องเป็นการตัดสินใจและดำเนินการของ operator
- Phase B — การ normalize raw scans เป็น attendance events และเขียนเข้า `daily_attendance` — ยังไม่เริ่มตามเอกสาร
- `docs/ARCHITECTURE.md` ระบุว่า development/CI ใช้ fixtures หรือ disposable databases และไม่มีการเปลี่ยน production nginx หรือระบบ production ในขอบเขตสถาปัตยกรรมนี้
- `docs/STATUS.md` ณ วันที่ตรวจบันทึก Release 1 ว่ายังอยู่ระหว่างดำเนินงาน และ PR #50 เปิดอยู่

### ยังต้องตรวจสอบ

- มีข้อมูล Log จากเครื่อง HIP จริงอยู่ในสภาพแวดล้อมที่ได้รับอนุญาตหรือไม่ และไฟล์นั้นตรงกับ importer contract หรือไม่
- การ map `facescan_id` กับ identity master ครอบคลุมผู้ใช้ที่ต้องการหรือยัง; ห้ามใช้ชื่อบุคคลเป็นกุญแจเชื่อมโยง
- การออกแบบ Phase B, timezone/shift policy, การ reprocess, audit trail และเกณฑ์ยอมรับก่อนพิจารณา apply migration หรือ deploy

## งานถัดไปที่ต้องมีหลักฐาน

- [ ] ผู้ดูแลยืนยันรุ่นจากป้ายเครื่องหรือรายการอุปกรณ์ใน HIP Premium Time พร้อม family/firmware
- [ ] ได้ไฟล์ตัวอย่าง Log จาก workflow ที่ผู้ดูแลอนุมัติ และลบ PII/ข้อมูลลับก่อนนำมา review
- [ ] ระบุ file contract จากตัวอย่างจริง: encoding, columns, datetime, timezone, record identifiers และ duplicate behavior
- [ ] ทำ operator-approved live Jev smoke หลัง metadata fix; ไม่เรียก live API ซ้ำอัตโนมัติ
- [ ] ออกแบบ Phase B แยกจาก Phase A และขอ review ก่อนแตะ production หรือ apply migration
- [ ] เก็บ raw logs และข้อมูลบุคคล/biometric ไว้ในแหล่งที่ได้รับอนุญาต; ห้าม commit ลง repository สาธารณะ

## แหล่งอ้างอิง

- `docs/FACESCAN_RAW_INGESTION.md` — สถานะและสัญญาการ ingest FaceScan Phase A
- `docs/ARCHITECTURE.md` — ขอบเขต Attendance API และ Agent Core
- `docs/STATUS.md` — สถานะ Release 1 ณ วันที่ตรวจ
- คู่มือ HIP Premium Time Series 8 / Series U และ KB ในบริบทโครงการ — ใช้เป็นแหล่งอ้างอิงประกอบการคัด checkpoint; ไม่ใช่หลักฐานยืนยันสเปกเครื่องจริง

---
*เอกสารนี้เป็น checkpoint จากหลักฐานที่มี ณ 2026-10-19 ไม่ใช่การยืนยันการเชื่อมต่อเครื่อง, การนำเข้าข้อมูลจริง, หรือการอนุมัติ production.*
