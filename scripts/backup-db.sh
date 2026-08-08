#!/usr/bin/env bash
# Synie 数据库备份：pg_dump 自定义格式（-Fc）全量备份，带滚动保留。
#
# 连接（二选一，与 server 环境变量同风格）：
#   DATABASE_URL=postgres://user:pass@host:5432/synie   完整 DSN（生产：阿里云 PG）
#   PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE  分件（pg_dump 原生读取）
#
# 环境变量：
#   BACKUP_DIR        备份输出目录（默认 ./backups）
#   BACKUP_RETENTION  保留最近份数（默认 14，正整数）
#
# 退出码：0 成功；1 pg_dump 失败；2 参数/环境不合法。
# crontab 示例见 README「生产环境提示 → 备份与恢复」。
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${BACKUP_RETENTION:-14}"

if ! [[ "$RETENTION" =~ ^[0-9]+$ ]] || [ "$RETENTION" -lt 1 ]; then
  echo "错误：BACKUP_RETENTION 必须是正整数（当前：$RETENTION）" >&2
  exit 2
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "错误：未找到 pg_dump，请先安装 PostgreSQL 客户端工具（版本应与服务器一致）" >&2
  exit 2
fi
if [ -z "${DATABASE_URL:-}" ] && [ -z "${PGDATABASE:-}" ]; then
  echo "错误：请设置 DATABASE_URL（完整 DSN）或 PG* 分件（PGHOST/PGUSER/PGDATABASE 等）" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/synie-$TS.dump"
# 先写临时文件、成功后再改名：失败清理绝不误伤同秒撞名的既有好备份
TMP_FILE="$FILE.tmp-$$"

echo "[backup-db] 开始备份 → $FILE"
if [ -n "${DATABASE_URL:-}" ]; then
  OK=0
  pg_dump --format=custom --no-owner --file="$TMP_FILE" "$DATABASE_URL" || OK=$?
else
  OK=0
  pg_dump --format=custom --no-owner --file="$TMP_FILE" || OK=$?
fi
if [ "$OK" -ne 0 ]; then
  rm -f "$TMP_FILE"
  echo "[backup-db] 错误：pg_dump 执行失败（退出码 $OK），不完整文件已清理" >&2
  exit 1
fi
mv -f "$TMP_FILE" "$FILE"
SIZE="$(du -h "$FILE" | cut -f1)"
echo "[backup-db] 备份完成：$FILE（$SIZE）"

# 滚动保留：按修改时间从新到旧，删除第 N 份之后的
ls -1t "$BACKUP_DIR"/synie-*.dump 2>/dev/null | tail -n +"$((RETENTION + 1))" | while read -r OLD; do
  echo "[backup-db] 清理过期备份：$OLD"
  rm -f "$OLD"
done
