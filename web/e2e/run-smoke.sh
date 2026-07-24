#!/usr/bin/env bash
#
# 权限浏览器薄冒烟一键脚本(authz-e2e 工单11):建演示库 → 起后端 → 起前端 →
# 跑 Playwright 冒烟 → 收摊。新人照跑即可,不进 PR CI。
#
# 用法:
#   web/e2e/run-smoke.sh                # 默认后端 4010 / 前端 3010(避开主 checkout 的 4000/3000)
#   BACKEND_PORT=4020 FRONTEND_PORT=3020 web/e2e/run-smoke.sh
#
# 前置:
#   - Elixir/mix 在 PATH(或已 export ~/.elixir-install 的 bin)
#   - web/node_modules 已装(含 @heroui-pro 真实包,需根 .env 的 HeroUI token)
#   - Playwright 浏览器已装:`cd web && bunx playwright install chromium`
#   - Postgres 可用(synie-pg,5440)
set -euo pipefail

BACKEND_PORT="${BACKEND_PORT:-4010}"
FRONTEND_PORT="${FRONTEND_PORT:-3010}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$(cd "$WEB_DIR/../backend" && pwd)"

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo "[e2e] 收摊……"
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for() {
  local url="$1" name="$2" tries=60
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

echo "[e2e] 建演示库(reset + demo,库内 admin/admin123 + 公司 JT + 全业务链数据)……"
( cd "$BACKEND_DIR" && MIX_ENV=dev mix synie.db.reset && MIX_ENV=dev mix synie.demo )

echo "[e2e] 起后端(PORT=$BACKEND_PORT,绑 0.0.0.0)……"
( cd "$BACKEND_DIR" && PORT="$BACKEND_PORT" MIX_ENV=dev mix phx.server ) &
BACKEND_PID=$!
wait_for "http://localhost:$BACKEND_PORT/graphql" "后端 GraphQL"

echo "[e2e] 起前端(vite --host --port $FRONTEND_PORT,代理指向后端 $BACKEND_PORT)……"
( cd "$WEB_DIR" && BACKEND_PORT="$BACKEND_PORT" bun run dev -- --host --port "$FRONTEND_PORT" ) &
FRONTEND_PID=$!
wait_for "http://localhost:$FRONTEND_PORT/login" "前端"

echo "[e2e] 跑 Playwright 冒烟……"
cd "$WEB_DIR"
E2E_BASE_URL="http://localhost:$FRONTEND_PORT" \
  E2E_GRAPHQL_URL="http://localhost:$BACKEND_PORT/graphql" \
  bunx playwright test "$@"

echo "[e2e] 冒烟通过 ✅"
