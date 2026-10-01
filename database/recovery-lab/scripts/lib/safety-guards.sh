#!/usr/bin/env bash
# Shared safety guards for recovery-lab scripts. Source, do not execute directly.
# Refuses production datadir paths, live evidence paths, and unsafe MariaDB exposure.

set -euo pipefail

: "${RECOVERY_LAB_SCRIPT_NAME:=${0##*/}}"

recovery_lab_is_truthy() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

RECOVERY_LAB_DRY_RUN=0
if recovery_lab_is_truthy "${DRY_RUN:-0}"; then
  RECOVERY_LAB_DRY_RUN=1
fi

recovery_lab_dry_run_msg() {
  echo "[DRY_RUN] $*"
}

recovery_lab_require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "${RECOVERY_LAB_SCRIPT_NAME}: required command not found: ${cmd}" >&2
    exit 1
  }
}

# Paths that must never be used as lab datadir or writable import targets.
recovery_lab_forbidden_datadir_regexes=(
  '^/var/lib/mysql/?$'
  '^/var/lib/mysql/'
  '^/usr/local/mysql/data/?$'
  '^/usr/local/mysql/data/'
)

# Evidence copied from production must live under an explicitly lab-marked directory.
recovery_lab_evidence_markers=(
  'recovery-lab'
  'LAB_'
  'lab-evidence'
  'mysql-recovery-lab'
)

recovery_lab_path_is_forbidden_production_datadir() {
  local path="$1"
  local normalized
  normalized=$(readlink -f "$path" 2>/dev/null || echo "$path")
  local re
  for re in "${recovery_lab_forbidden_datadir_regexes[@]}"; do
    if [[ "$normalized" =~ $re ]]; then
      return 0
    fi
  done
  return 1
}

recovery_lab_path_has_lab_marker() {
  local path="$1"
  local marker
  for marker in "${recovery_lab_evidence_markers[@]}"; do
    if [[ "$path" == *"$marker"* ]]; then
      return 0
    fi
  done
  return 1
}

recovery_lab_assert_lab_datadir() {
  local datadir="${1:-${LAB_DATADIR:-}}"
  if [[ -z "$datadir" ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: LAB_DATADIR is not set" >&2
    exit 1
  fi
  if recovery_lab_path_is_forbidden_production_datadir "$datadir"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: refused production datadir LAB_DATADIR=${datadir}" >&2
    echo "Use a dedicated lab path (e.g. /var/lib/mysql-recovery-lab or /tmp/recovery-lab/datadir)." >&2
    exit 1
  fi
  if ! recovery_lab_path_has_lab_marker "$datadir"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: LAB_DATADIR must contain a lab marker (${recovery_lab_evidence_markers[*]})" >&2
    exit 1
  fi
}

recovery_lab_assert_evidence_dir() {
  local dir="${1:-${LAB_EVIDENCE_DIR:-}}"
  if [[ -z "$dir" || ! -d "$dir" ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: LAB_EVIDENCE_DIR must point to an existing directory (copy of attendance_db)" >&2
    exit 1
  fi
  if recovery_lab_path_is_forbidden_production_datadir "$dir"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: refused production evidence path LAB_EVIDENCE_DIR=${dir}" >&2
    echo "Copy attendance_db to a lab-only directory first; never import from /var/lib/mysql/attendance_db in place." >&2
    exit 1
  fi
  if ! recovery_lab_path_has_lab_marker "$dir"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: LAB_EVIDENCE_DIR must contain a lab marker (${recovery_lab_evidence_markers[*]})" >&2
    exit 1
  fi
  local resolved
  resolved=$(readlink -f "$dir")
  if [[ "$resolved" == */mysql/attendance_db ]] || [[ "$resolved" == */mysql/attendance_db/ ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: refused path that looks like live production schema dir: ${resolved}" >&2
    exit 1
  fi
}

recovery_lab_assert_ibd_copy() {
  local ibd="$1"
  local evidence="${LAB_EVIDENCE_DIR:-}"
  if [[ ! -f "$ibd" ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: missing .ibd copy: ${ibd}" >&2
    exit 1
  fi
  if recovery_lab_path_is_forbidden_production_datadir "$ibd"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: refused production .ibd path: ${ibd}" >&2
    exit 1
  fi
  if [[ -n "$evidence" ]]; then
    local ibd_abs evidence_abs
    ibd_abs=$(readlink -f "$ibd")
    evidence_abs=$(readlink -f "$evidence")
    if [[ "$ibd_abs" != "$evidence_abs"/* ]]; then
      echo "${RECOVERY_LAB_SCRIPT_NAME}: .ibd must be under LAB_EVIDENCE_DIR (${evidence_abs})" >&2
      exit 1
    fi
  elif ! recovery_lab_path_has_lab_marker "$ibd"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: .ibd path must be under LAB_EVIDENCE_DIR or contain a lab marker" >&2
    exit 1
  fi
}

recovery_lab_assert_skip_networking_socket() {
  local socket="${1:-${LAB_SOCKET:-}}"
  if [[ -z "$socket" ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: LAB_SOCKET is not set" >&2
    exit 1
  fi
  if recovery_lab_is_truthy "${RECOVERY_LAB_ALLOW_TCP:-0}"; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: RECOVERY_LAB_ALLOW_TCP is forbidden for recovery execution" >&2
    exit 1
  fi
}

recovery_lab_assert_mysqld_skip_networking() {
  recovery_lab_require_cmd mariadb
  local socket="${LAB_SOCKET:-}"
  recovery_lab_assert_skip_networking_socket "$socket"
  if [[ ! -S "$socket" ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: MariaDB socket not found: ${socket}" >&2
    exit 1
  fi
  local port
  port=$(mariadb --socket="$socket" -u root -N -e "SELECT @@port;" 2>/dev/null || true)
  if [[ -n "$port" && "$port" != "0" ]]; then
    echo "${RECOVERY_LAB_SCRIPT_NAME}: server reports @@port=${port}; lab must use --skip-networking (port 0)" >&2
    exit 1
  fi
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn 2>/dev/null | grep -q ':3306'; then
      if recovery_lab_is_truthy "${RECOVERY_LAB_IGNORE_SS_CHECK:-0}"; then
        echo "${RECOVERY_LAB_SCRIPT_NAME}: warning: something listens on TCP 3306 (RECOVERY_LAB_IGNORE_SS_CHECK=1)" >&2
      else
        echo "${RECOVERY_LAB_SCRIPT_NAME}: refused: TCP 3306 is in use; stop production/listener or use isolated host" >&2
        exit 1
      fi
    fi
  fi
}

recovery_lab_priority_tables=(
  employees
  daily_attendance
  monthly_summary
  leave_balance
  staging_leave
)
