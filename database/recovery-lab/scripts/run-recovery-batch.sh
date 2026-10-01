#!/usr/bin/env bash
# Run DISCARD/IMPORT for priority tables in fixed order on copied .ibd files only.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

DB="${LAB_RECOVERY_DATABASE:-recovery_lab}"
WF="${SCRIPT_DIR}/import-tablespace-workflow.sh"

recovery_lab_assert_evidence_dir "${LAB_EVIDENCE_DIR:-}"
recovery_lab_assert_mysqld_skip_networking

for tbl in "${recovery_lab_priority_tables[@]}"; do
  ibd="${LAB_EVIDENCE_DIR}/${tbl}.ibd"
  if [[ ! -f "$ibd" ]]; then
    echo "SKIP missing ${ibd}" >&2
    continue
  fi
  echo "=== ${tbl} ==="
  if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
    recovery_lab_dry_run_msg "${WF} ${DB} ${tbl} ${ibd}"
  else
    bash "$WF" "$DB" "$tbl" "$ibd"
  fi
done

bash "${SCRIPT_DIR}/validate-table-metadata.sh" "$DB"
echo "RECOVERY_BATCH_DONE"
