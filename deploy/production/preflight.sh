#!/usr/bin/env bash
# Read-only production readiness check for RAE Attendance V2.
#
# Changes nothing: no restart, no write, no migration, no routing change. Every statement is a
# SELECT or a file read. Run it before any cutover, and again afterwards to compare.
#
# usage: deploy/production/preflight.sh [--sha <target-sha>]
set -uo pipefail

RUNTIME=/home/rae_admin/rae-attendance-v2-runtime
CHECKOUT=/home/rae_admin/RAE-Attendance-System-V2
BACKUP_DIR=/var/backups/attendance-v2
TARGET_SHA=""
[ "${1:-}" = "--sha" ] && TARGET_SHA="${2:-}"

PASS=0; FAIL=0; WARN=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  WARN  %s\n' "$1"; WARN=$((WARN+1)); }

echo "== 1. code"
[ -d "$CHECKOUT/.git" ] && ok "checkout present: $CHECKOUT" || bad "checkout missing: $CHECKOUT"
HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD 2>/dev/null | cut -c1-7)
echo "  info  checkout HEAD=$HEAD_SHA"
if [ -n "$TARGET_SHA" ]; then
  git -C "$CHECKOUT" cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null \
    && ok "target sha $TARGET_SHA is available locally" \
    || warn "target sha $TARGET_SHA not local yet (cutover fetches it)"
fi
RUNNING_IMG=$(docker inspect -f '{{.Config.Image}}' rae-v2-backend 2>/dev/null)
echo "  info  running backend image=$RUNNING_IMG"
case "$RUNNING_IMG" in
  *"$HEAD_SHA"*|*"${TARGET_SHA:0:7}"*) ok "running image tag matches source" ;;
  *) warn "running image tag does not match the checkout — drift, cutover will rebuild" ;;
esac

echo "== 2. database (read-only)"
MDB=rae-v2-mariadb
q() { docker exec -i "$MDB" sh -lc 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD" -N' ; }
DB_NAME=$(docker exec rae-v2-backend sh -lc 'echo $DB_NAME' 2>/dev/null)
TABLES=$(q <<< "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB_NAME';" 2>/dev/null | tr -d '\r')
EMPLOYEES=$(q <<< "SELECT COUNT(*) FROM $DB_NAME.employees;" 2>/dev/null | tr -d '\r')
LINKED=$(q <<< "SELECT COUNT(*) FROM $DB_NAME.employee_identity_links WHERE status='approved';" 2>/dev/null | tr -d '\r')
APPLIED=$(q <<< "SELECT COUNT(*) FROM $DB_NAME.schema_migrations;" 2>/dev/null | tr -d '\r')
echo "  info  db=$DB_NAME tables=${TABLES:-?} migrations_recorded=${APPLIED:-0} employees=${EMPLOYEES:-?} approved_links=${LINKED:-0}"
[ "${APPLIED:-0}" -ge 1 ] 2>/dev/null && ok "migration ledger is in use" || warn "migration ledger empty — schema predates the runner"
[ "${TABLES:-0}" -ge 28 ] 2>/dev/null && ok "schema has all 28 tables" || bad "schema has ${TABLES:-0}/28 tables — migrations required"
[ "${EMPLOYEES:-0}" -ge 1 ] 2>/dev/null && ok "personnel rows present: ${EMPLOYEES}" || bad "personnel master is EMPTY — nobody can sign in (see roster onboarding)"
[ "${LINKED:-0}" -ge 1 ] 2>/dev/null && ok "approved identity links: ${LINKED}" || warn "no approved identity link yet — SSO would deny every login"
LAST_BACKUP=$(ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -1)
[ -n "$LAST_BACKUP" ] && ok "recent dump: $LAST_BACKUP" || warn "no dump in $BACKUP_DIR yet"

echo "== 3. services"
for c in rae-v2-mariadb rae-v2-backend rae-v2-frontend; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$c" 2>/dev/null)
  if [ "$st" != "running" ]; then bad "$c ${st:-missing}"
  elif [ "$h" = "healthy" ] || [ "$h" = "n/a" ]; then ok "$c running health=$h"
  else warn "$c running health=$h"; fi
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3210/api/v1/health)
[ "$CODE" = "200" ] && ok "backend health 200" || bad "backend health $CODE"

echo "== 4. sso configuration (names only, never values)"
COMPOSE=$RUNTIME/docker-compose.yml
for key in SSO_ENABLED SSO_CLIENT_ID SSO_CLIENT_SECRET SSO_CALLBACK_URL SSO_CALLBACK_CONFIRMED APP_URL; do
  line=$(grep -E "^[[:space:]]+$key:" "$COMPOSE" 2>/dev/null | head -1)
  val=$(printf '%s' "$line" | sed -E "s/.*$key:[[:space:]]*//; s/[\"']//g" | tr -d '\r')
  case "$val" in
    ''|"''") warn "$key is empty — SSO cannot be activated" ;;
    "'false'") warn "$key=false — SSO stays disabled (expected until activation is approved)" ;;
    *'${'*) warn "$key resolves from .env — verify the value is present and non-empty" ;;
    *) ok "$key is set" ;;
  esac
done

echo "== 5. routing"
VHOST=/etc/nginx/sites-enabled/raeservice.mju.ac.th.conf
grep -q 'proxy_pass http://127.0.0.1:3210/api/v1/' "$VHOST" && ok "/api/v1/ -> backend 3210" || bad "/api/v1/ upstream not the V2 backend"
grep -q 'proxy_pass http://127.0.0.1:8088/' "$VHOST" && ok "/attendance-v2/ -> frontend 8088" || bad "/attendance-v2/ upstream not the V2 frontend"
[ -d /var/backups/attv2-e2e ] && ok "nginx backup dir present" || warn "no nginx backup dir"
# `nginx -t` needs root; as rae_admin it always fails, which is not a config problem.
if nginx -t >/dev/null 2>&1; then ok "nginx config valid"
elif [ "$(id -u)" != "0" ]; then warn "nginx -t needs root — verify with: sudo -n /usr/local/bin/attv2-e2e-sso-route.sh status"
else bad "nginx config invalid"; fi

echo "== 5b. migration path"
MIGDIR=$CHECKOUT/database/migrations
DRIFT=0
while read -r v; do
  [ -f "$MIGDIR/$v" ] || { warn "ledger records $v which no longer exists in the checkout"; DRIFT=1; }
done < <(q <<< "SELECT version FROM $DB_NAME.schema_migrations;" 2>/dev/null | tr -d '\r')
[ "$DRIFT" -eq 0 ] && ok "ledger filenames all exist in the checkout"
[ "${TABLES:-0}" -lt 28 ] && echo "  note  in-place migration from this schema FAILS at 013 (duplicate key uk_employee_identifier_type_value); rehearse the fresh path before choosing" 

echo "== 6. capacity"
AVAIL=$(df -Pm / | awk 'NR==2{print $4}')
[ "${AVAIL:-0}" -ge 3000 ] && ok "root volume free ${AVAIL}MB" || bad "root volume free ${AVAIL}MB (<3000MB)"
[ -d "$RUNTIME/frontend-dist" ] && ok "frontend-dist present (bind-mounted, no image rebuild needed)" || bad "frontend-dist missing"

echo
echo "RESULT: pass=$PASS fail=$FAIL warn=$WARN"
[ "$FAIL" -eq 0 ] || echo "DECISION: NOT READY — resolve FAIL items (WARN are owner decisions, not defects)"
