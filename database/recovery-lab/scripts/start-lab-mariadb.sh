#!/usr/bin/env bash
# Initialize (once) and start isolated MariaDB with --skip-networking only.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

LAB_DATADIR="${LAB_DATADIR:-/var/lib/mysql-recovery-lab}"
LAB_SOCKET="${LAB_SOCKET:-/tmp/recovery-lab/socket/mysqld.sock}"
LAB_PID_FILE="${LAB_PID_FILE:-/tmp/recovery-lab/mysqld.pid}"

recovery_lab_assert_lab_datadir "$LAB_DATADIR"
recovery_lab_assert_skip_networking_socket "$LAB_SOCKET"
recovery_lab_require_cmd mariadb-install-db
recovery_lab_require_cmd mysqld

mkdir -p "$(dirname "$LAB_SOCKET")"
mkdir -p "$LAB_DATADIR"
chown mysql:mysql "$LAB_DATADIR" 2>/dev/null || sudo chown mysql:mysql "$LAB_DATADIR"

if [[ ! -d "${LAB_DATADIR}/mysql" ]]; then
  if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
    recovery_lab_dry_run_msg "mariadb-install-db --datadir=${LAB_DATADIR}"
  else
    mariadb-install-db --user=mysql --datadir="$LAB_DATADIR" --skip-test-db
  fi
fi

if [[ -S "$LAB_SOCKET" ]]; then
  echo "MariaDB already listening on ${LAB_SOCKET}"
  recovery_lab_assert_mysqld_skip_networking
  exit 0
fi

CMD=(
  mysqld
  --user=mysql
  --datadir="$LAB_DATADIR"
  --socket="$LAB_SOCKET"
  --pid-file="$LAB_PID_FILE"
  --skip-networking
  --bind-address=127.0.0.1
)

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "${CMD[*]}"
  exit 0
fi

nohup "${CMD[@]}" >>/tmp/recovery-lab/mysqld.log 2>&1 &
for _ in $(seq 1 30); do
  if [[ -S "$LAB_SOCKET" ]]; then
    recovery_lab_assert_mysqld_skip_networking
    echo "STARTED_LAB_MARIADB socket=${LAB_SOCKET} datadir=${LAB_DATADIR}"
    exit 0
  fi
  sleep 1
done

echo "${RECOVERY_LAB_SCRIPT_NAME}: timed out waiting for ${LAB_SOCKET}" >&2
exit 1
