#!/usr/bin/env bash
# Import a COPIED orphan .ibd into a recreated table in the lab instance.
# Usage: import-tablespace-workflow.sh <db> <table> <path/to/copy/table.ibd>
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

SOCKET="${LAB_SOCKET:-/tmp/recovery-lab/socket/mysqld.sock}"
DB="${1:-}"
TABLE="${2:-}"
IBD_COPY="${3:-}"

if [[ -z "$DB" || -z "$TABLE" || -z "$IBD_COPY" ]]; then
  echo "Usage: $0 <database> <table> /path/to/copy/table.ibd" >&2
  exit 1
fi

recovery_lab_assert_ibd_copy "$IBD_COPY"
recovery_lab_assert_mysqld_skip_networking

mysql_cli() {
  mariadb --socket="$SOCKET" -u root "$@"
}

DATADIR=$(mysql_cli -N -e "SELECT @@datadir;")
if recovery_lab_path_is_forbidden_production_datadir "$DATADIR"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: refused: server @@datadir is production path: ${DATADIR}" >&2
  exit 1
fi

TARGET="${DATADIR}/${DB}/${TABLE}.ibd"

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "DISCARD TABLESPACE ${DB}.${TABLE}"
  recovery_lab_dry_run_msg "cp ${IBD_COPY} -> ${TARGET}"
  recovery_lab_dry_run_msg "IMPORT TABLESPACE ${DB}.${TABLE}"
  exit 0
fi

mysql_cli "$DB" -e "ALTER TABLE \`${TABLE}\` DISCARD TABLESPACE;"
rm -f "$TARGET"
cp "$IBD_COPY" "$TARGET"
chown mysql:mysql "$TARGET" 2>/dev/null || sudo chown mysql:mysql "$TARGET"
mysql_cli "$DB" -e "ALTER TABLE \`${TABLE}\` IMPORT TABLESPACE;"
echo "IMPORT_OK ${DB}.${TABLE}"
