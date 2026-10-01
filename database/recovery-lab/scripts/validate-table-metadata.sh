#!/usr/bin/env bash
# Validate recovered tables: ENGINE, row counts, checksum metadata only (no row samples).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

DB="${1:-${LAB_RECOVERY_DATABASE:-recovery_lab}}"
TABLE="${2:-}"

recovery_lab_assert_mysqld_skip_networking
recovery_lab_require_cmd mariadb

mysql_n() {
  mariadb --socket="${LAB_SOCKET}" -u root -N "$@"
}

tables=()
if [[ -n "$TABLE" ]]; then
  tables=("$TABLE")
else
  tables=("${recovery_lab_priority_tables[@]}")
fi

echo "# recovery validation metadata"
echo "database: ${DB}"
echo "generated_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf "%-24s %-10s %12s %12s\n" "table" "engine" "table_rows" "data_length"

for tbl in "${tables[@]}"; do
  line=$(mysql_n -e "
    SELECT CONCAT(
      '${tbl}', '\t',
      IFNULL(ENGINE,'NULL'), '\t',
      IFNULL(TABLE_ROWS,'0'), '\t',
      IFNULL(DATA_LENGTH,'0')
    )
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA='${DB}' AND TABLE_NAME='${tbl}';
  " || true)
  if [[ -z "$line" ]]; then
    printf "%-24s %-10s %12s %12s\n" "$tbl" "MISSING" "-" "-"
    continue
  fi
  IFS=$'\t' read -r _ engine rows dlen <<<"$line"
  printf "%-24s %-10s %12s %12s\n" "$tbl" "$engine" "$rows" "$dlen"
  if [[ "$RECOVERY_LAB_DRY_RUN" -eq 0 ]]; then
    cnt=$(mysql_n "$DB" -e "SELECT COUNT(*) FROM \`${tbl}\`;" 2>/dev/null || echo "ERR")
    echo "  count_exact: ${cnt}"
  fi
done

echo "VALIDATION_METADATA_DONE"
