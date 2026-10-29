# Dark-deploy handoff V7 — 2026-10-29

สถานะสรุป: **`DARK_DEPLOY_READY=NO`**

เอกสารนี้เป็นหลักฐานการเตรียมการแบบ read-only และ disposable เท่านั้น ไม่มีการ deploy,
restart service, live MJU sign-in, persistent migration, เปิด secret หรือเปลี่ยน repository
permission

## 1. สิ่งที่ยืนยันแล้ว

| รายการ | หลักฐาน |
|---|---|
| Attendance clone | `/home/prinyaroot/agent-workspace/sso-v4/att`, `main=825a941105fa4dfc5e1444ec5c371c17e1469e7d`, clean, ตรง `origin/main` |
| SSO clone | `/home/prinyaroot/agent-workspace/sso-v4/sso`, `main=e5799f84b005ef49a6297cd234cda8725397ecd8`, clean, ตรง `origin/main` |
| Attendance GitHub main | `protected=true`; strict required checks 9 รายการ: `backend`, `backend-mariadb`, `security slices (mariadb 10.11.14)`, `compose-smoke`, `container`, `frontend`, `pages-build`, `secrets`, `agent-core` |
| Attendance CI | run `40895911928` บน `825a941`: ทั้ง 9 required jobs สำเร็จ; `pages-build` run `40895912054` สำเร็จ |
| SSO GitHub main | `protected=true`; CI run `40847892432` สำเร็จ (`CI`) แต่ API รายงาน `required_status_checks=null` — เป็น gap ที่ต้องยืนยันกับเจ้าของ ไม่แก้สิทธิ์ในรอบนี้ |
| Approved-link/session security | ยังคง fail-closed: ไม่ใช้ citizen ID/e-mail เป็น authorization, approved link เท่านั้น, session ต้อง rotate, logout ต้อง POST+CSRF |

## 2. VPS ที่ตรวจจริงแบบ read-only

Target `10.1.254.237` ตอบ hostname `ubantu24` (alias `ubuntu24` resolve ไม่ได้) และไม่ใช่
deployment จากสอง clone ข้างต้น:

- active edge คือ **Apache 2.4** บน 80/443; `nginx` inactive
- `raemanagemju.net` / `raeservice.mju.ac.th` ใช้ `/var/www/html` และ route legacy
- `/Cemployee/(sso|api|...)` proxy ไป `127.0.0.1:8088`; systemd `node-app.service` รัน
  `/home/prinyaroot/Cemployee/app.js` ในฐานะ `root`
- host MariaDB active คือ **10.11.14**; มี Docker MariaDB อื่นด้วย (`n6-maria`,
  `sso-v4-p0-mariadb` ที่ `127.0.0.1:13994`)
- Docker ที่พบอีกตัวคือ `attendance-report-attendance-1` ที่ `127.0.0.1:8096`
- ไม่พบ `sso-v4/att` หรือ `sso-v4/sso` เป็น process/compose deployment ที่ active
- root filesystem เหลือประมาณ **181 MB / 82 GB (100%)**; การเริ่ม disposable MariaDB
  ครั้งแรกหยุดด้วย `Errcode 28 No space left on device`
- ในเส้นทาง `/var/backups`, `/home/backup` และ paths ที่ตรวจ ไม่พบ dump backup ของ
  Attendance ที่ยืนยัน restore ได้ และไม่พบ scheduled `mysqldump`/`mariadb-dump` ที่ยืนยันได้

ข้อสรุป: production path, DB ownership, backup/restore และ rollback ของระบบจริงยังไม่ถูก
รับรองพอสำหรับ cutover; ห้ามใช้ runbook nginx/compose ของ V2 ไปชี้ที่ legacy host โดยอนุมาน

## 3. Disposable deployment/rollback rehearsal

ใช้ compose จาก `main` ด้วย project แยก `darkdeploy_v7`, MariaDB บน tmpfs เพื่อหลบ disk-full,
และพอร์ตเฉพาะ `127.0.0.1:13307`, `13210`, `18080` (ไม่ใช้ host 3306 และไม่แตะ service เดิม)

- build backend/frontend สำเร็จ
- migrations ปัจจุบัน `001–017, 020–026, 028` apply สำเร็จใน disposable DB
- `/api/v1/ready`, `/api/v1/health`, `/api/v1/health/db` และ frontend proxy ผ่าน
- `compose-smoke` ผ่าน: login → me → employees → attendance/monthly/leave → refresh
- `SSO_ENABLED=false` ตอบ `403 SSO_DISABLED` โดยไม่ทำ live MJU call
- seed guard ปฏิเสธ `DEPLOY_ENV=staging` ก่อนเปิด DB connection; fixture seed ถูกใช้เฉพาะ
  disposable tmpfs เพื่อ smoke และไม่มีข้อมูลจริง
- `docker compose down -v --remove-orphans` ลบเฉพาะ stack นี้; ตรวจแล้ว containers เดิม
  `n6-maria`, `sso-v4-p0-mariadb`, `attendance-report-attendance-1` ยังอยู่ และล้าง test artifact แล้ว

นี่พิสูจน์ deploy artifact และ rollback ของ **isolated stack** เท่านั้น ไม่ใช่ production rollback

## 4. Dark-deploy matrix

| Feature | ต้องคงค่า | วิธี verify | ห้ามทำ |
|---|---|---|---|
| MJU SSO | `SSO_ENABLED=false`, callback/subject contract false, diagnostic false | route ตอบ `SSO_DISABLED`; log/egress ต้องไม่มี MJU exchange | live sign-in, ใช้ client/secret จริง, เปิด unverified contract บน production |
| Approved-link identity | เปิด policy ตลอด | e-mail/citizen ID อย่างเดียวต้องไม่มี session; approved current unique link เท่านั้น | auto-approve candidate/pending/revoked หรือ bypass guard |
| National-ID lookup | ไม่มี `NATIONAL_ID_HMAC_KEYS` → fail closed | operation ต้องปฏิเสธ/503 และไม่พิมพ์ raw ID | เก็บ/ค้น raw national ID หรือใส่ key จริงใน git |
| Migration 029 / N-6 | **ยังไม่ apply**; main ยังจบที่ 028 | ledger disposable ต้องไม่มี 029; รอ PR #83 + owner approval | รัน 029/backfill บน host ก่อน source backfill และ duplicate clearance |
| Rule engine D-10 | unwired | ไม่มี production caller/route; boundary tests เป็น evidence เท่านั้น | wire attendance calculation ก่อน D-10/component/approval ครบ |
| FaceScan promotion | disabled / component `staging_facescan_raw → attendance_events` ยังขาด | ตรวจไม่มี job/route promotion ใน artifact | promote raw events บน production |
| Fixture seed | false; `DEPLOY_ENV=staging/production` | guard ต้อง refuse ก่อน connection | `db:seed` หรือ `migrate:seed` กับ persistent/production DB |
| Agent Core / optional modules | off unless explicitly configured | readiness ต้องผ่านโดยไม่พึ่ง optional service | เปิด integration ที่ไม่มี owner/contract/rollback |

## 5. Migration และ legacy slice chain

- #83 เพิ่ม migration `029_national_id_subject_key.sql`, down file, operator backfill และ
  duplicate detection; **ยังไม่ merge/ไม่ apply**. Migration abort เมื่อมี national-ID rows
  และต้องมี source backfill ที่ตรวจ duplicate ก่อน
- #80 เป็น design record + DDL test ของ N-6; ไม่ใช่ production approval
- #36 unique work คือ employee effective-dating, facescan CSV/identity services/tests/docs;
  ให้สกัดเฉพาะ code/tests/docs และ **drop migration/rollback 020/021** ที่ main มีแล้ว
- #37 unique work คือ attendance rule/calculation, Agent decision-only boundary,
  repositories/services/tests/docs; **drop migration/rollback 022/023** ที่ main มีแล้ว
- #39 unique work คือ monthly summary calculation/repository/service/tests/docs;
  **drop migration/rollback 024** ที่ main มีแล้ว
- chain #36 → #37 → #39 base เก่าและชน main หลายจุด; ใช้ `merge-tree`/สกัด commit เป็นชิ้น
  ทีละ PR พร้อมรัน required 9 checks ห้าม rebase ทั้ง chain ซึ่งจะทำ migration ซ้ำและเสี่ยง ledger พัง

## 6. Blockers ก่อนขอ approval เดียว

1. เจ้าของ VPS/DB ต้องยืนยัน deployment target, free space, backup + restore proof, Apache
   rollback และ change window; ห้ามแก้ด้วยการลบ volume/service ที่มีอยู่
2. ต้องตัดสิน MariaDB authoritative version (repo compose 11.4, security CI/VPS 10.11.14)
3. ต้องมี owner approval สำหรับ N-6/029 และ source backfill/duplicate-clearance
4. MJU ต้องตอบ B-00…B-05 และ owner ต้องอนุมัติ staging live test; ไม่มี live sign-in ในรอบนี้
5. ต้องระบุผู้รับผิดชอบ component `staging_facescan_raw → attendance_events` และ D-10 wiring

จนกว่าจะปิด blockers เหล่านี้ ผลที่ถูกต้องคือ **`DARK_DEPLOY_READY=NO`**. Branch protection,
approved-link security และ required Attendance 9 checks ห้ามลด/ข้ามเพื่อให้ผ่าน gate.
