#!/usr/bin/env bash
# Write SHA-256 checksums for copied .frm/.ibd evidence (read-only). No row data.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/safety-guards.sh
source "${SCRIPT_DIR}/lib/safety-guards.sh"
RECOVERY_LAB_SCRIPT_NAME=${0##*/}

DIR="${1:-${LAB_EVIDENCE_DIR:-}}"
OUT="${2:-${LAB_CHECKSUM_FILE:-}}"

recovery_lab_assert_evidence_dir "$DIR"
recovery_lab_require_cmd sha256sum

if [[ -z "$OUT" ]]; then
  OUT="${DIR}/../checksums-$(basename "$DIR")-$(date -u +%Y%m%dT%H%M%SZ).sha256"
fi

if recovery_lab_path_is_forbidden_production_datadir "$(dirname "$OUT")"; then
  echo "${RECOVERY_LAB_SCRIPT_NAME}: refused checksum output under production datadir" >&2
  exit 1
fi

echo "checksum_output: $OUT"
echo "evidence_dir: $(readlink -f "$DIR")"
echo "generated_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "$RECOVERY_LAB_DRY_RUN" -eq 1 ]]; then
  recovery_lab_dry_run_msg "would write checksums to ${OUT}"
  find "$DIR" -maxdepth 1 -type f \( -name '*.frm' -o -name '*.ibd' \) | sort
  exit 0
fi

(
  cd "$DIR"
  find . -maxdepth 1 -type f \( -name '*.frm' -o -name '*.ibd' \) -print0 \
    | sort -z \
    | xargs -0 sha256sum
) | tee "$OUT"
echo "WROTE_CHECKSUMS ${OUT}"
