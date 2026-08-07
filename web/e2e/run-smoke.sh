#!/usr/bin/env bash
#
# Bun 版一键 e2e：重置演示库 → 迁移 → 起 Bun server →
# 初始化向导示例路径(超管 + JT 公司 + 全业务链示例数据,见 e2e/provision-demo.ts)→
# 起前端 → 跑 playwright.api.config.ts → 收摊。
#
# 用法:
#   web/e2e/run-smoke.sh                 # 默认 API 8090 / 前端 3011
#   SYNIE_API_PORT=8090 FRONTEND_PORT=3020 web/e2e/run-smoke.sh
#   KEEP_DB=1 web/e2e/run-smoke.sh       # 不重建库(要求库已迁移、已初始化、超管口令一致)
#
# 前置:
#   - Bun、Docker 在 PATH;compose postgres 可用(脚本会自动 docker compose up -d postgres)
#   - web/node_modules 已装(含 @heroui-pro 真实包,需根 .env 的 HeroUI token)
#   - Playwright 浏览器已装:`cd web && bunx playwright install chromium`
set -euo pipefail

# 默认 8090 避开主 checkout 的开发后端 8080;部分 spec 直连 API(SYNIE_API_URL)
SYNIE_API_PORT="${SYNIE_API_PORT:-${GO_API_PORT:-8090}}"
FRONTEND_PORT="${FRONTEND_PORT:-3011}"
KEEP_DB="${KEEP_DB:-}"

PG_CONTAINER="${PG_CONTAINER:-synie-postgres-1}"
PG_USER="${PG_USER:-synie}"
PG_DB="${PG_DB:-synie}"
DATABASE_URL="${DATABASE_URL:-postgres://synie:synie@localhost:5441/${PG_DB}?sslmode=disable}"

ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-admin}"
# 必须与各 *.api.e2e.ts 的 E2E_ADMIN_PASSWORD 默认值一致
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-admin123}"
# 仅本脚本内使用,e2e 栈专用,不得复用到其他环境
AUTH_SECRET="${AUTH_SECRET:-e2e-local-secret-do-not-use-elsewhere-32b}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$WEB_DIR/.." && pwd)"
SERVER_DIR="$ROOT_DIR/server"

SERVER_PID=""
FRONTEND_PID=""

cleanup() {
  echo "[e2e] 收摊……"
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() {
  local url="$1" name="$2" tries=90
  echo "[e2e] 等待 $name ($url) ……"
  until curl -sf -o /dev/null "$url" 2>/dev/null; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "[e2e] $name 启动超时" >&2
      exit 1
    fi
    sleep 1
  done
  echo "[e2e] $name 就绪"
}

psql_admin() {
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 "$@"
}

echo "[e2e] 起 Postgres(compose)……"
( cd "$ROOT_DIR" && docker compose up -d postgres )
echo "[e2e] 等待 Postgres 就绪……"
until docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
  sleep 1
done

if [ -z "$KEEP_DB" ]; then
  echo "[e2e] 重建数据库 $PG_DB(销毁其中全部数据;KEEP_DB=1 可跳过)……"
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PG_DB' AND pid <> pg_backend_pid();" \
             -c "DROP DATABASE IF EXISTS $PG_DB;" \
             -c "CREATE DATABASE $PG_DB OWNER $PG_USER;"
fi

echo "[e2e] 执行 SQL 迁移……"
( cd "$SERVER_DIR" && DATABASE_URL="$DATABASE_URL" bun db/migrate.ts )

echo "[e2e] 启动 Bun 后端(:$SYNIE_API_PORT)……"
( cd "$SERVER_DIR" && \
  PORT="$SYNIE_API_PORT" \
  HOST="0.0.0.0" \
  DATABASE_URL="$DATABASE_URL" \
  AUTH_SECRET="$AUTH_SECRET" \
  AUTH_TOKEN_TTL=24h \
  bun src/index.ts ) &
SERVER_PID=$!
wait_for "http://localhost:$SYNIE_API_PORT/api/v1/healthz" "Bun 后端"

if [ -z "$KEEP_DB" ]; then
  echo "[e2e] 初始化向导(示例数据路径):建超管 + JT 公司 + 全业务链示例数据……"
  API_BASE="http://localhost:$SYNIE_API_PORT/api/v1" \
  E2E_ADMIN_USERNAME="$ADMIN_USERNAME" \
  E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    bun "$SCRIPT_DIR/provision-demo.ts"
else
  echo "[e2e] KEEP_DB=1:跳过建库与初始化(要求 $ADMIN_USERNAME 已存在且口令一致)"
fi

# numbering.api.e2e 需要三个候选资源中至少一个无启用规则
echo "[e2e] 停用 mfg.operation 编号规则(为 numbering spec 留候选)……"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE sys_numbering_rule SET enabled = false WHERE resource = 'mfg.operation';" \
  || true

echo "[e2e] 起前端(vite --host --port $FRONTEND_PORT,代理 /api/v1 → :$SYNIE_API_PORT)……"
( cd "$WEB_DIR" && SYNIE_API_PORT="$SYNIE_API_PORT" bun run dev -- --host --port "$FRONTEND_PORT" ) &
FRONTEND_PID=$!
wait_for "http://localhost:$FRONTEND_PORT/login" "前端"

echo "[e2e] 跑 Playwright(API 配置)……"
cd "$WEB_DIR"
E2E_BASE_URL="http://localhost:$FRONTEND_PORT" \
E2E_ADMIN_USERNAME="$ADMIN_USERNAME" \
E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
SYNIE_API_URL="http://127.0.0.1:$SYNIE_API_PORT/api/v1" \
GO_API_URL="http://127.0.0.1:$SYNIE_API_PORT/api/v1" \
SYNIE_PG_DB="$PG_DB" \
SYNIE_PG_CONTAINER="$PG_CONTAINER" \
  bunx playwright test --config=playwright.api.config.ts "$@"

echo "[e2e] 冒烟通过 ✅"
