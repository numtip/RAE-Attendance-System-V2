#!/usr/bin/env bash
# Pre-flight checks before recovery execution on the lab host.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

recovery_lab_assert_evidence_dir "${LAB_EVIDENCE_DIR:-}"
recovery_lab_assert_lab_datadir "${LAB_DATADIR:-}"
recovery_lab_assert_skip_networking_socket "${LAB_SOCKET:-}"

if [[ -S "${LAB_SOCKET}" ]]; then
  recovery_lab_assert_mysqld_skip_networking
  echo "OK: MariaDB socket ${LAB_SOCKET} (skip-networking verified)"
else
  echo "NOTE: MariaDB not running yet on ${LAB_SOCKET}; start with start-lab-mariadb.sh before import"
fi

for tbl in "${recovery_lab_priority_tables[@]}"; do
  if [[ ! -f "${LAB_EVIDENCE_DIR}/${tbl}.ibd" ]]; then
    echo "WARN: missing copy ${LAB_EVIDENCE_DIR}/${tbl}.ibd" >&2
  else
    echo "OK: evidence ${tbl}.ibd present"
  fi
done

echo "LAB_ENVIRONMENT_OK"
