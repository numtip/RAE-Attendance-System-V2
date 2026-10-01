#!/usr/bin/env bash
# Synthetic proof that DISCARD + copy .ibd + IMPORT TABLESPACE works on lab MariaDB.
# Requires: mariadb client, running server on LAB_SOCKET (skip-networking).
set -euo pipefail

SOCKET="${LAB_SOCKET:-/tmp/recovery-lab/socket/mysqld.sock}"
DB=recovery_poc

mysql() {
  sudo mariadb --socket="$SOCKET" -u root "$@"
}

mysql -e "CREATE DATABASE IF NOT EXISTS ${DB};"
mysql "$DB" -e "
  DROP TABLE IF EXISTS poc_employees;
  CREATE TABLE poc_employees (
    employee_uid varchar(36) NOT NULL,
    email varchar(100) NOT NULL,
    PRIMARY KEY (employee_uid)
  ) ENGINE=InnoDB;
  INSERT INTO poc_employees VALUES ('11111111-1111-1111-1111-111111111111', 'poc@test.local');
"

IBD_DIR=$(mysql -N -e "SELECT @@datadir;")/${DB}
IBD="${IBD_DIR}/poc_employees.ibd"
ORPHAN="/tmp/recovery-lab/poc_employees.orphan.ibd"
mkdir -p /tmp/recovery-lab
sudo cp "$IBD" "$ORPHAN"

mysql "$DB" -e "ALTER TABLE poc_employees DISCARD TABLESPACE;"
sudo rm -f "$IBD"
sudo cp "$ORPHAN" "$IBD"
sudo chown mysql:mysql "$IBD"
mysql "$DB" -e "ALTER TABLE poc_employees IMPORT TABLESPACE;"

COUNT=$(mysql -N "$DB" -e "SELECT COUNT(*) FROM poc_employees;")
EMAIL=$(mysql -N "$DB" -e "SELECT email FROM poc_employees LIMIT 1;")
echo "POC_OK rows=${COUNT} sample_email=${EMAIL}"
