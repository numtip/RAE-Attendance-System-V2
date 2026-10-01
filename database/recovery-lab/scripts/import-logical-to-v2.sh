#!/usr/bin/env bash
# Import a lab logical SQL file into a clean V2 MariaDB (not production legacy).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

SQL_FILE="${1:-${LAB_EXPORT_FILE:-}}"
V2_SOCKET="${V2_TARGET_SOCKET:-${LAB_V2_SOCKET:-}}"
V2_DB="${V2_TARGET_DATABASE:-attendance_v2}"

if [[ -z "$SQL_FILE" || ! -f "$SQL_FILE" ]]; then
  echo "Usage: LAB_V2_SOCKET=... $0 /tmp/recovery-lab/export/recovery_lab-....sql" >&2
  exit 1
fi

if recovery_lab_path_is_forbidden_production_datadir "$SQL_FILE"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: refused SQL path under production datadir" >&2
  exit 1
fi
if ! recovery_lab_path_has_lab_marker "$SQL_FILE"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: SQL file path must contain a lab marker" >&2
  exit 1
fi

if [[ -z "$V2_SOCKET" ]]; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: set V2_TARGET_SOCKET or LAB_V2_SOCKET" >&2
  exit 1
fi
if [[ ! -S "$V2_SOCKET" ]]; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: V2 socket not found: ${V2_SOCKET}" >&2
  exit 1
fi

if recovery_lab_is_truthy "${RECOVERY_LAB_ALLOW_TCP:-0}"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: TCP import to production is forbidden" >&2
  exit 1
fi

recovery_lab_require_cmd mariadb

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "mariadb --socket=${V2_SOCKET} ${V2_DB} < ${SQL_FILE}"
  exit 0
fi

mariadb --socket="$V2_SOCKET" -u root -e "CREATE DATABASE IF NOT EXISTS \`${V2_DB}\`;"
mariadb --socket="$V2_SOCKET" -u root "$V2_DB" <"$SQL_FILE"
echo "V2_IMPORT_OK database=${V2_DB}"
