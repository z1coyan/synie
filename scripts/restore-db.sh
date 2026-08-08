#!/usr/bin/env bash
# Synie 数据库恢复：pg_restore 恢复 backup-db.sh 产出的自定义格式备份。
#
# 危险操作：--clean 会先删目标库同名对象再重建，目标库现有数据将被覆盖。
# 必须显式设置 RESTORE_CONFIRM=yes 才执行。
#
# 用法：
#   RESTORE_CONFIRM=yes DATABASE_URL=postgres://... ./scripts/restore-db.sh <备份文件.dump>
#   （或 PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE 分件）
#
# 建议先恢复到临时库演练验证，再对生产库执行。
# 退出码：0 成功；1 pg_restore 报错；2 参数/环境不合法或未确认。
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "错误：备份文件不存在：${FILE:-（未提供）}" >&2
  echo "用法：RESTORE_CONFIRM=yes DATABASE_URL=postgres://... $0 <备份文件.dump>" >&2
  exit 2
fi
if ! command -v pg_restore >/dev/null 2>&1; then
  echo "错误：未找到 pg_restore，请先安装 PostgreSQL 客户端工具" >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ] && [ -z "${PGDATABASE:-}" ]; then
  echo "错误：请设置 DATABASE_URL（完整 DSN）或 PG* 分件（PGHOST/PGUSER/PGDATABASE 等）" >&2
  exit 2
fi
if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
  echo "恢复将覆盖目标库现有数据，此操作不可撤销。" >&2
  echo "确认无误请设置 RESTORE_CONFIRM=yes 后重试。" >&2
  exit 2
fi

echo "[restore-db] 开始恢复：$FILE"
if [ -n "${DATABASE_URL:-}" ]; then
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$FILE"
else
  pg_restore --clean --if-exists --no-owner --no-privileges "$FILE"
fi
echo "[restore-db] 恢复完成。请接着执行 bun db/migrate.ts 补齐备份之后的迁移。"
