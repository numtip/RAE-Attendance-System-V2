#!/usr/bin/env bash
# Read-only inventory of a COPIED attendance_db evidence directory.
# Usage: LAB_EVIDENCE_DIR=/path/to/lab-evidence/attendance_db inventory-evidence.sh
#    or: inventory-evidence.sh /path/to/lab-evidence/attendance_db
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

DIR="${1:-${LAB_EVIDENCE_DIR:-}}"
recovery_lab_assert_evidence_dir "$DIR"

echo "# attendance_db evidence inventory"
echo "path: $(readlink -f "$DIR")"
echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""
echo "## .frm / .ibd files"
printf "%-40s %12s %s\n" "file" "bytes" "mtime_utc"
for ext in frm ibd; do
  while IFS= read -r -d '' f; do
    base=$(basename "$f")
    size=$(stat -c '%s' "$f")
    mtime=$(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)
    printf "%-40s %12s %s\n" "$base" "$size" "$mtime"
  done < <(find "$DIR" -maxdepth 1 -type f -name "*.$ext" -print0 | sort -z)
done

parent=$(dirname "$DIR")
if [[ -f "$parent/ibdata1" ]]; then
  ib="$parent/ibdata1"
  echo ""
  echo "## ibdata1 (parent of schema dir)"
  echo "bytes: $(stat -c '%s' "$ib")"
  echo "mtime_utc: $(date -u -r "$ib" +%Y-%m-%dT%H:%M:%SZ)"
fi

echo ""
echo "## priority .ibd presence"
for tbl in "${recovery_lab_priority_tables[@]}"; do
  if [[ -f "$DIR/${tbl}.ibd" ]]; then
    echo "OK ${tbl}.ibd"
  else
    echo "MISSING ${tbl}.ibd"
  fi
done
