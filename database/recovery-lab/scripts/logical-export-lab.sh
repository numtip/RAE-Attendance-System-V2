#!/usr/bin/env bash
# Logical export from lab DB to SQL file (no commit to git). Sensitive columns omitted for staging_leave.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

DB="${LAB_RECOVERY_DATABASE:-recovery_lab}"
OUT="${LAB_EXPORT_FILE:-}"

recovery_lab_assert_mysqld_skip_networking
recovery_lab_require_cmd mysqldump

if [[ -z "$OUT" ]]; then
  OUT="/tmp/recovery-lab/export/${DB}-$(date -u +%Y%m%dT%H%M%SZ).sql"
fi

if recovery_lab_path_is_forbidden_production_datadir "$(dirname "$OUT")"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: refused export path under production datadir" >&2
  exit 1
fi
if ! recovery_lab_path_has_lab_marker "$OUT"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: export path must contain a lab marker" >&2
  exit 1
fi

TABLES=(
  employees
  daily_attendance
  monthly_summary
  leave_balance
)

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "mysqldump ${DB} ${TABLES[*]} and staging_leave (redacted) -> ${OUT}"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"

mysqldump --socket="${LAB_SOCKET}" -u root --single-transaction --skip-lock-tables \
  "$DB" "${TABLES[@]}" >"$OUT"

# Redact sensitive staging_leave columns when mysqldump supports --ignore-column.
_staging_tmp="${OUT}.staging_leave.partial"
if mysqldump --help 2>&1 | grep -q 'ignore-column'; then
  mysqldump --socket="${LAB_SOCKET}" -u root --single-transaction --skip-lock-tables \
    "$DB" staging_leave \
    --ignore-column=staging_leave.national_id_encrypted \
    --ignore-column=staging_leave.raw_data >>"$OUT"
else
  mysqldump --socket="${LAB_SOCKET}" -u root --single-transaction --skip-lock-tables \
    --no-data "$DB" staging_leave >>"$OUT"
  cat >>"$OUT" <<'EOF'

-- staging_leave row data omitted from automated export (mysqldump lacks --ignore-column).
-- Export redacted rows on the lab host only, e.g. SELECT id, leave_id, employee_id,
-- employee_uid, leave_type, start_date, end_date, status, is_processed, match_status,
-- sync_date, error_message, created_at, updated_at FROM staging_leave;
EOF
  mariadb --socket="${LAB_SOCKET}" -u root "$DB" -e "
    SELECT id, leave_id, employee_id, employee_uid, leave_type, start_date, end_date,
           status, is_processed, match_status, sync_date, error_message, created_at, updated_at
    FROM staging_leave
  " >"${_staging_tmp}.tsv" 2>/dev/null || true
  echo "-- operator-local redacted TSV (do not commit): ${_staging_tmp}.tsv" >&2
fi

echo "EXPORT_OK file=${OUT} bytes=$(stat -c '%s' "$OUT")"
