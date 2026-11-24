-- MJU HR's published national holiday policy, with later official dates where required.
-- INSERT IGNORE preserves existing owner decisions. Candidate dates do not affect calculations.
INSERT IGNORE INTO attendance_holiday
  (holiday_date, name, scope, status, source_system, source_reference, approved_by, approved_at, created_at, updated_at)
VALUES
  ('2026-01-01', 'วันขึ้นปีใหม่', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-01-02', 'วันหยุดราชการกรณีพิเศษ', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-03-03', 'วันมาฆบูชา', 'national', 'approved', 'government', 'https://webportal.bangkok.go.th/healthcenter29', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-04-06', 'วันจักรี', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-04-13', 'วันสงกรานต์', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-04-14', 'วันสงกรานต์', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-04-15', 'วันสงกรานต์', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-05-04', 'วันฉัตรมงคล', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-05-13', 'วันพืชมงคล', 'national', 'approved', 'government', 'https://mot.go.th/PRNews/1470', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-05-31', 'วันวิสาขบูชา', 'national', 'approved', 'government', 'https://pathumthani.moc.go.th/th/content/category/detail/id/161/iid/167497', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-06-01', 'วันหยุดชดเชยวันวิสาขบูชา', 'national', 'approved', 'government', 'https://pathumthani.moc.go.th/th/content/category/detail/id/161/iid/167497', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-06-03', 'วันเฉลิมพระชนมพรรษาพระบรมราชินี', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-07-28', 'วันเฉลิมพระชนมพรรษาพระบาทสมเด็จพระเจ้าอยู่หัว', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-07-29', 'วันอาสาฬหบูชา', 'national', 'approved', 'government', 'https://phetchaburi.immigration.go.th/index.php/ita?catid=2&id=625%3Aitao2-69&view=article', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-07-30', 'วันเข้าพรรษา', 'national', 'approved', 'government', 'https://phetchaburi.immigration.go.th/index.php/ita?catid=2&id=625%3Aitao2-69&view=article', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-08-12', 'วันแม่แห่งชาติ', 'national', 'approved', 'government', 'https://www.thaigov.go.th/th/news/166703', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-10-13', 'วันนวมินทรมหาราช', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-10-23', 'วันปิยมหาราช', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-12-05', 'วันชาติและวันพ่อแห่งชาติ', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-12-07', 'วันหยุดชดเชยวันชาติ', 'national', 'approved', 'government', 'https://admin-ict-cmsmoi.moi.go.th/calendar', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-12-10', 'วันรัฐธรรมนูญ', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-12-31', 'วันสิ้นปี', 'national', 'approved', 'mju_personnel', 'https://personnel.mju.ac.th/holiday69.php', 'official_notice', NOW(), NOW(), NOW()),
  ('2026-12-16', 'วันหยุดราชการกรณีพิเศษ — รอตรวจสอบ ม.แม่โจ้', 'national', 'candidate', 'government', 'https://www.thaigov.go.th/th/news/171072', NULL, NULL, NOW(), NOW());
