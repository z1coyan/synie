#!/bin/sh
set -eu

alias_name="synie"
endpoint="${SYNIE_S3_INTERNAL_ENDPOINT:?缺少 SYNIE_S3_INTERNAL_ENDPOINT}"
access_key="${MINIO_ROOT_USER:?缺少 MINIO_ROOT_USER}"
secret_key="${MINIO_ROOT_PASSWORD:?缺少 MINIO_ROOT_PASSWORD}"
mode="${1:-init}"

export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/synie-mc}"
mc alias set "$alias_name" "$endpoint" "$access_key" "$secret_key" --api S3v4 >/dev/null

expected_buckets="
convex-modules
convex-search-indexes
convex-snapshot-exports
convex-snapshot-imports
convex-user-files
synie-product-files"

initialize() {
  for bucket in $expected_buckets; do
    mc mb --ignore-existing "$alias_name/$bucket" >/dev/null
    mc anonymous set none "$alias_name/$bucket" >/dev/null
  done

  # Only disposable prefixes expire automatically. Formal files/ objects have
  # no provider expiry and are removed solely by the durable Convex delete job.
  mc ilm import "$alias_name/synie-product-files" >/dev/null <<'EOF'
{
  "Rules": [
    {
      "Expiration": { "Days": 1 },
      "ID": "expire-abandoned-uploads",
      "Filter": { "Prefix": "uploads/" },
      "Status": "Enabled"
    },
    {
      "Expiration": { "Days": 1 },
      "ID": "expire-print-temporaries",
      "Filter": { "Prefix": "print-tmp/" },
      "Status": "Enabled"
    }
  ]
}
EOF
}

verify() {
  # minio/mc 官方镜像刻意极简，没有 sed/grep/sort；用 POSIX shell
  # 精确检查六个 JSONL key，避免为了 bootstrap 额外维护工具镜像。
  bucket_list=/tmp/synie-buckets.jsonl
  mc ls --json "$alias_name" >"$bucket_list"
  bucket_count=0
  seen_modules=0
  seen_search=0
  seen_exports=0
  seen_imports=0
  seen_files=0
  seen_product=0
  while IFS= read -r line; do
    bucket_count=$((bucket_count + 1))
    case "$line" in
      *'"key":"convex-modules/"'*) seen_modules=1 ;;
      *'"key":"convex-search-indexes/"'*) seen_search=1 ;;
      *'"key":"convex-snapshot-exports/"'*) seen_exports=1 ;;
      *'"key":"convex-snapshot-imports/"'*) seen_imports=1 ;;
      *'"key":"convex-user-files/"'*) seen_files=1 ;;
      *'"key":"synie-product-files/"'*) seen_product=1 ;;
      *)
        echo "MinIO 出现非预期 bucket: $line" >&2
        exit 1
        ;;
    esac
  done <"$bucket_list"
  if [ "$bucket_count" -ne 6 ] || [ "$seen_modules$seen_search$seen_exports$seen_imports$seen_files$seen_product" != "111111" ]; then
    echo "MinIO bucket 集合不符合预期（count=$bucket_count）" >&2
    exit 1
  fi

  for bucket in $expected_buckets; do
    policy="$(mc anonymous get "$alias_name/$bucket" 2>&1)"
    case "$policy" in
      *private*) ;;
      *)
        echo "bucket $bucket 不是 private" >&2
        exit 1
        ;;
    esac
  done


  lifecycle="$(mc ilm export "$alias_name/synie-product-files")"
  case "$lifecycle" in
    *expire-abandoned-uploads*uploads/*) ;;
    *)
      echo "产品 bucket lifecycle 缺少 uploads/ 过期规则" >&2
      exit 1
      ;;
  esac
  case "$lifecycle" in
    *expire-print-temporaries*print-tmp/*) ;;
    *)
      echo "产品 bucket lifecycle 缺少 print-tmp/ 过期规则" >&2
      exit 1
      ;;
  esac
  case "$lifecycle" in
    *'"Prefix":"files/'*|*'"Prefix": "files/'*)
      echo "产品 bucket lifecycle 不得覆盖正式 files/ 前缀" >&2
      exit 1
      ;;
  esac

  echo "MinIO 验证通过：六个且仅六个 private bucket，正式 files/ 无过期规则"
  printf '%s\n' "$expected_buckets"
}

case "$mode" in
  init)
    initialize
    verify
    ;;
  verify)
    verify
    ;;
  *)
    echo "用法: minio-init.sh [init|verify]" >&2
    exit 2
    ;;
esac
