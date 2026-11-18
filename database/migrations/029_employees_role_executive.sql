-- The CLI reads employees.role. Authorization already maps 'executive' to EXECUTIVE, but this
-- enum stopped at user, so that role could not be stored. The new value is appended, so existing
-- admin/manager/user rows stay valid. Running this statement again leaves the same enum.
ALTER TABLE employees
  MODIFY COLUMN role ENUM('admin', 'manager', 'user', 'executive') DEFAULT NULL;
