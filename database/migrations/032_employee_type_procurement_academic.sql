-- Owner's personnel file (01-updatedb2.csv) lists one personnel type, "นักวิชาการพัสดุ", that is not one
-- of the three existing types. The new value is appended, so existing rows stay valid.
-- Running this statement again leaves the same enum.
ALTER TABLE employees
  MODIFY COLUMN employee_type ENUM('university', 'department', 'contract', 'procurement_academic') NOT NULL;
