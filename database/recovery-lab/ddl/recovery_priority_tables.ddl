-- Recreate DDL for orphan .ibd import (lab only). Match docs/CURRENT_DATABASE_SCHEMA.md.
-- Apply on isolated MariaDB database `recovery_lab` before DISCARD/IMPORT workflow.

CREATE DATABASE IF NOT EXISTS recovery_lab
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE recovery_lab;

DROP TABLE IF EXISTS staging_leave;
DROP TABLE IF EXISTS leave_balance;
DROP TABLE IF EXISTS monthly_summary;
DROP TABLE IF EXISTS daily_attendance;
DROP TABLE IF EXISTS employees;

CREATE TABLE employees (
  employee_uid varchar(36) NOT NULL,
  employee_id varchar(50) NOT NULL,
  first_name_th varchar(100) NOT NULL,
  last_name_th varchar(100) NOT NULL,
  first_name_en varchar(100) DEFAULT NULL,
  last_name_en varchar(100) DEFAULT NULL,
  email varchar(100) NOT NULL,
  password_hash varchar(255) DEFAULT NULL,
  last_login datetime DEFAULT NULL,
  login_attempts int(11) DEFAULT NULL,
  locked_until datetime DEFAULT NULL,
  phone varchar(20) DEFAULT NULL,
  department varchar(100) NOT NULL,
  position varchar(100) DEFAULT NULL,
  employee_type enum('university','department','contract') NOT NULL,
  hire_date date DEFAULT NULL,
  status enum('active','inactive','resigned') NOT NULL,
  role enum('admin','manager','user') DEFAULT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY (employee_uid),
  UNIQUE KEY employee_id (employee_id),
  UNIQUE KEY email (email),
  KEY department (department),
  KEY employee_type (employee_type),
  KEY status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE daily_attendance (
  id int(11) NOT NULL,
  employee_uid varchar(36) NOT NULL,
  date date NOT NULL,
  check_in datetime DEFAULT NULL,
  check_out datetime DEFAULT NULL,
  is_late tinyint(1) NOT NULL,
  late_minutes int(11) NOT NULL,
  work_duration decimal(5,2) NOT NULL,
  is_leave tinyint(1) NOT NULL,
  leave_type enum('sick','personal','vacation','other') DEFAULT NULL,
  status enum('present','late','absent','leave','holiday') NOT NULL,
  notes text DEFAULT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY (id),
  KEY employee_uid (employee_uid),
  KEY date (date),
  KEY status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE monthly_summary (
  id int(11) NOT NULL,
  employee_uid varchar(36) NOT NULL,
  year int(11) NOT NULL,
  month int(11) NOT NULL,
  total_work_days int(11) NOT NULL,
  total_present int(11) NOT NULL,
  total_late int(11) NOT NULL,
  total_absent int(11) NOT NULL,
  total_leave int(11) NOT NULL,
  total_late_minutes int(11) NOT NULL,
  total_work_hours decimal(6,2) NOT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY (id),
  KEY employee_uid (employee_uid),
  KEY year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leave_balance (
  id int(11) NOT NULL,
  employee_uid varchar(36) NOT NULL,
  year int(11) NOT NULL,
  leave_type enum('sick','personal','vacation','maternity','paternity','study') NOT NULL,
  total_days decimal(5,2) NOT NULL,
  used_days decimal(5,2) NOT NULL,
  remaining_days decimal(5,2) NOT NULL,
  created_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  PRIMARY KEY (id),
  KEY employee_uid (employee_uid),
  KEY year (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE staging_leave (
  id int(11) NOT NULL,
  leave_id varchar(100) NOT NULL,
  employee_id varchar(20) DEFAULT NULL,
  employee_uid varchar(36) DEFAULT NULL,
  national_id_encrypted text DEFAULT NULL,
  leave_type varchar(50) DEFAULT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status varchar(20) DEFAULT NULL,
  is_processed tinyint(1) DEFAULT NULL,
  match_status enum('matched','unmatched','pending') DEFAULT NULL,
  sync_date datetime DEFAULT NULL,
  raw_data text DEFAULT NULL,
  error_message text DEFAULT NULL,
  created_at datetime DEFAULT NULL,
  updated_at datetime DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY leave_id (leave_id),
  KEY employee_id (employee_id),
  KEY employee_uid (employee_uid),
  KEY start_date (start_date),
  KEY is_processed (is_processed),
  KEY match_status (match_status),
  KEY sync_date (sync_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
