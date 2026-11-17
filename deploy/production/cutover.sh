#!/usr/bin/env bash
# Production cutover for RAE Attendance V2 — prepared, never run by an agent.
#
# Requires two explicit flags so that nothing here can be triggered by accident or by a scheduled job:
#   --sha <full-or-short-sha>   the commit to deploy (must be on GitHub main)
#   --confirm-production        the owner's approval for THIS run
# Optional, each its own decision:
#   --migrate                   apply pending SQL migrations (schema changes are not covered by --confirm-production)
#
# What it does, in order: preflight -> dump -> git checkout -> migrate (only with --migrate) ->
# build backend image -> build frontend dist -> swap -> recreate -> verify. Any failure after the first
# change triggers rollback() which restores the dump, the previous image tag and the previous dist.
#
# usage:
#   deploy/production/cutover.sh --sha d564731 --confirm-production            # code only (needs the schema already current)
#   deploy/production/cutover.sh --sha d564731 --confirm-production --migrate  # code + schema
set -euo pipefail

RUNTIME=/home/rae_admin/rae-attendance-v2-runtime
CHECKOUT=/home/rae_admin/RAE-Attendance-System-V2
BACKUP_DIR=/home/rae_admin/backups/attendance-v2
COMPOSE="docker compose -p rae-attendance-v2 --env-file $RUNTIME/.env -f $RUNTIME/docker-compose.yml"
TS=$(date +%Y%m%dT%H%M%S)

SHA=""; CONFIRM=0; MIGRATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="${2:-}"; shift 2 ;;
    --confirm-production) CONFIRM=1; shift ;;
    --migrate) MIGRATE=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
[ -n "$SHA" ] || { echo "REFUSED: --sha is required"; exit 2; }
[ "$CONFIRM" -eq 1 ] || { echo "REFUSED: --confirm-production is required (owner approval)"; exit 2; }

say() { printf '%s\n' "$*"; }
fail() { say "FAILED: $*"; }

PREV_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
PREV_IMAGE=$(docker inspect -f '{{.Config.Image}}' rae-v2-backend)
PREV_TAG=${PREV_IMAGE##*:}
DUMP=""
DIST_PREV=""

rollback() {
  say "== ROLLBACK =="
  if [ -n "$DUMP" ] && [ -f "$DUMP" ]; then
    say "restoring database from $DUMP"
    gunzip -c "$DUMP" | docker exec -i rae-v2-mariadb sh -lc 'mariadb -u root -p"$MARIADB_ROOT_PASSWORD"' || say "!! database restore reported an error"
  fi
  if [ -n "$DIST_PREV" ] && [ -d "$DIST_PREV" ]; then
    say "restoring frontend dist from $DIST_PREV"
    rm -rf "$RUNTIME/frontend-dist" && mv "$DIST_PREV" "$RUNTIME/frontend-dist"
  fi
  docker tag "rae-attendance-v2-backend:$PREV_TAG" rae-attendance-v2-backend:current 2>/dev/null || true
  say "pinning backend image back to $PREV_TAG and restarting"
  sed -i -E "s|image: rae-attendance-v2-backend:.*|image: rae-attendance-v2-backend:$PREV_TAG|" "$RUNTIME/docker-compose.yml"
  git -C "$CHECKOUT" checkout -q "$PREV_SHA"
  $COMPOSE up -d --force-recreate backend frontend
  say "rollback done — verify: curl -s http://127.0.0.1:3210/api/v1/health"
}

say "== 0. preflight (read-only) =="
bash "$(dirname "$0")/preflight.sh" --sha "$SHA" | sed 's/^/  /'
say "   preflight is advisory here; the gates below are the hard ones"

say "== 1. resolve target commit =="
git -C "$CHECKOUT" fetch -q origin main
TARGET=$(git -C "$CHECKOUT" rev-parse "$SHA^{commit}")
git -C "$CHECKOUT" merge-base --is-ancestor "$TARGET" origin/main \
  || { fail "$SHA is not on origin/main"; exit 3; }
say "   target=$TARGET (on main) previous=$PREV_SHA"

say "== 2. backup =="
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
DB_NAME=$(docker exec rae-v2-backend sh -lc 'echo $DB_NAME')
DUMP=$BACKUP_DIR/$TS-pre-cutover.sql.gz
docker exec -i rae-v2-mariadb sh -lc 'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --events "$1"' _ "$DB_NAME" | gzip > "$DUMP"
gunzip -t "$DUMP" || { fail "dump is not a valid gzip"; exit 3; }
say "   dump=$(stat -c%s "$DUMP") bytes -> $DUMP"

say "== 3. checkout =="
git -C "$CHECKOUT" checkout -q "$TARGET"
say "   HEAD=$(git -C "$CHECKOUT" rev-parse --short HEAD)"

if [ "$MIGRATE" -eq 1 ]; then
  say "== 4. migrations =="
  # Same runner the staging stack uses, on the production network. Credentials go through a 0600
  # env-file so they never appear in the process list.
  NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' rae-v2-backend)
  DB_USER=$(docker exec rae-v2-backend sh -lc 'echo $DB_USER')
  DB_PASS=$(docker exec rae-v2-backend sh -lc 'echo $DB_PASSWORD')
  ENVF=$(mktemp); chmod 600 "$ENVF"
  printf 'MYSQL_HOST=mariadb\nMYSQL_PORT=3306\nMYSQL_USER=%s\nMYSQL_PASSWORD=%s\nMYSQL_DATABASE=%s\n' \
    "$DB_USER" "$DB_PASS" "$DB_NAME" > "$ENVF"
  run_migrate() {
    docker run --rm --network "$NET" -v "$CHECKOUT:/workspace" -w /workspace --env-file "$ENVF" \
      node:20-alpine sh -lc 'npm ci --no-audit --no-fund >/dev/null 2>&1 || npm i mysql2@3 --no-audit --no-fund >/dev/null 2>&1; node scripts/migrate.mjs '"$1"
  }
  run_migrate --dry-run || { rm -f "$ENVF"; fail "dry-run refused"; rollback; exit 4; }
  run_migrate "" || { rm -f "$ENVF"; fail "migration failed"; rollback; exit 4; }
  rm -f "$ENVF"
else
  say "== 4. migrations SKIPPED (no --migrate) =="
  say "   check: schema must already match this commit before it can serve traffic"
fi

say "== 5. backend image =="
IMAGE_TAG="rae-attendance-v2-backend:$(git -C "$CHECKOUT" rev-parse --short HEAD)"
docker build -f "$CHECKOUT/deploy/docker/backend/Dockerfile" -t "$IMAGE_TAG" "$CHECKOUT" \
  || { fail "backend build"; rollback; exit 5; }
say "   built $IMAGE_TAG"

say "== 6. frontend dist =="
BUILD_DIR=$(mktemp -d)
# Copy out of the read-only mount first: npm ci writes node_modules next to the sources.
docker run --rm -v "$CHECKOUT/frontend:/src:ro" -v "$BUILD_DIR:/out" -e VITE_BASE_PATH=/attendance-v2/ node:20-alpine \
  sh -lc 'mkdir -p /work && cp -a /src/. /work/ && cd /work && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1 && cp -a dist/. /out/' \
  || { fail "frontend build"; rollback; exit 6; }
grep -q '/attendance-v2/assets/' "$BUILD_DIR/index.html" \
  || { fail "frontend built without the deployment base path"; rollback; exit 6; }
DIST_PREV=$RUNTIME/frontend-dist.prev-$TS
cp -a "$RUNTIME/frontend-dist" "$DIST_PREV"
rm -rf "${RUNTIME:?}/frontend-dist" && cp -a "$BUILD_DIR" "$RUNTIME/frontend-dist"
say "   dist swapped (previous kept at $DIST_PREV)"

say "== 7. recreate =="
sed -i -E "s|image: rae-attendance-v2-backend:.*|image: $IMAGE_TAG|" "$RUNTIME/docker-compose.yml"
$COMPOSE up -d --force-recreate backend frontend || { fail "recreate"; rollback; exit 7; }

say "== 8. verify =="
sleep 12
for i in 1 2 3 4 5; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://127.0.0.1:3210/api/v1/health || true)
  [ "$CODE" = "200" ] && break || sleep 5
done
OK=1
[ "$CODE" = "200" ] || { say "   backend health $CODE"; OK=0; }
APP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8088/attendance-v2/ || true)
[ "$APP" = "200" ] || { say "   frontend $APP"; OK=0; }
ASSET=$(curl -s --max-time 8 http://127.0.0.1:8088/attendance-v2/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -s -o /dev/null -w '' --max-time 8 "http://127.0.0.1:8088/attendance-v2/$ASSET" || OK=0
[ "$OK" -eq 1 ] || { fail "verification"; rollback; exit 8; }

say "   health=200 frontend=200 asset=$ASSET"
say "== DONE =="
say "   deployed $TARGET · image $IMAGE_TAG · dump $DUMP"
say "   rollback by hand: git -C $CHECKOUT checkout $PREV_SHA && sed -i \"s|image: rae-attendance-v2-backend:.*|image: rae-attendance-v2-backend:$PREV_TAG|\" $RUNTIME/docker-compose.yml && $COMPOSE up -d --force-recreate backend frontend"
