-- Personal title (คำนำหน้านาม: นาย / นาง / นางสาว / ดร. / ...) kept apart from first_name_th so reports,
-- exports and name matching keep printing the same name; only the profile page shows the title.
-- Running this statement again leaves the same column.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS title_th VARCHAR(30) DEFAULT NULL AFTER employee_id;
