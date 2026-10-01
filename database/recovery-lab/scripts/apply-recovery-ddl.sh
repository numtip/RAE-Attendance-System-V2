#!/usr/bin/env bash
# Apply verified priority-table DDL in the lab instance (idempotent drops/recreates empty shells).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

SQL="${ROOT}/ddl/recovery_priority_tables.ddl"
DB="${LAB_RECOVERY_DATABASE:-recovery_lab}"

recovery_lab_assert_mysqld_skip_networking
recovery_lab_require_cmd mariadb

if [[ ! -f "$SQL" ]]; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: missing ${SQL}" >&2
  exit 1
fi

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "mariadb --socket=${LAB_SOCKET} < ${SQL}"
  exit 0
fi

mariadb --socket="${LAB_SOCKET}" -u root <"$SQL"
echo "DDL_APPLIED database=${DB}"
