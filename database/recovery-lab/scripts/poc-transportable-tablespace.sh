#!/usr/bin/env bash
# Synthetic proof that DISCARD + copy .ibd + IMPORT TABLESPACE works on lab MariaDB.
# Requires: mariadb client, running server on LAB_SOCKET (skip-networking).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

SOCKET="${LAB_SOCKET:-/tmp/recovery-lab/socket/mysqld.sock}"
DB=recovery_poc

recovery_lab_assert_mysqld_skip_networking

mysql_cli() {
  mariadb --socket="$SOCKET" -u root "$@"
}

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "synthetic POC on ${DB}"
  exit 0
fi

mysql_cli -e "CREATE DATABASE IF NOT EXISTS ${DB};"
mysql_cli "$DB" -e "
  DROP TABLE IF EXISTS poc_employees;
  CREATE TABLE poc_employees (
    employee_uid varchar(36) NOT NULL,
    email varchar(100) NOT NULL,
    PRIMARY KEY (employee_uid)
  ) ENGINE=InnoDB;
  INSERT INTO poc_employees VALUES ('11111111-1111-1111-1111-111111111111', 'poc@test.local');
"

IBD_DIR=$(mysql_cli -N -e "SELECT @@datadir;")/${DB}
IBD="${IBD_DIR}/poc_employees.ibd"
ORPHAN="/tmp/recovery-lab/poc_employees.orphan.ibd"
mkdir -p /tmp/recovery-lab
cp "$IBD" "$ORPHAN"

mysql_cli "$DB" -e "ALTER TABLE poc_employees DISCARD TABLESPACE;"
rm -f "$IBD"
cp "$ORPHAN" "$IBD"
chown mysql:mysql "$IBD" 2>/dev/null || sudo chown mysql:mysql "$IBD"
mysql_cli "$DB" -e "ALTER TABLE poc_employees IMPORT TABLESPACE;"

COUNT=$(mysql_cli -N "$DB" -e "SELECT COUNT(*) FROM poc_employees;")
echo "POC_OK rows=${COUNT} (email row omitted from log — no PII in output)"
