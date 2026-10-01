#!/usr/bin/env bash
# Read-only inventory of a COPIED attendance_db evidence directory.
# Usage: inventory-evidence.sh /path/to/copy/attendance_db
set -euo pipefail

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "Usage: $0 /path/to/copy/attendance_db" >&2
  exit 1
fi

echo "# attendance_db evidence inventory"
echo "path: $DIR"
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

if [[ -f "$DIR/../ibdata1" ]]; then
  ib="$DIR/../ibdata1"
  echo ""
  echo "## ibdata1 (sibling of schema dir)"
  echo "bytes: $(stat -c '%s' "$ib")"
  echo "mtime_utc: $(date -u -r "$ib" +%Y-%m-%dT%H:%M:%SZ)"
fi
