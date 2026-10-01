#!/usr/bin/env bash
# Import a COPIED orphan .ibd into a recreated table in the lab instance.
# Usage: import-tablespace-workflow.sh <db> <table> <path/to/copy/table.ibd>
set -euo pipefail

SOCKET="${LAB_SOCKET:-/tmp/recovery-lab/socket/mysqld.sock}"
DB="${1:-}"
TABLE="${2:-}"
IBD_COPY="${3:-}"

if [[ -z "$DB" || -z "$TABLE" || -z "$IBD_COPY" || ! -f "$IBD_COPY" ]]; then
  echo "Usage: $0 <database> <table> /path/to/copy/table.ibd" >&2
  exit 1
fi

mysql() {
  sudo mariadb --socket="$SOCKET" -u root "$@"
}

DATADIR=$(mysql -N -e "SELECT @@datadir;")
TARGET="${DATADIR}/${DB}/${TABLE}.ibd"

mysql "$DB" -e "ALTER TABLE \`${TABLE}\` DISCARD TABLESPACE;"
rm -f "$TARGET"
cp "$IBD_COPY" "$TARGET"
chown mysql:mysql "$TARGET" 2>/dev/null || sudo chown mysql:mysql "$TARGET"
mysql "$DB" -e "ALTER TABLE \`${TABLE}\` IMPORT TABLESPACE;"
echo "IMPORT_OK ${DB}.${TABLE}"
