-- +goose Up
-- 科目角色遵循其它 wire 枚举约定：API 大写，PostgreSQL 存储小写。
-- TS/Go 科目写路径曾把 wire 值原样写成大写，导致按角色筛选时与小写查询值不匹配。

UPDATE public.bas_account
SET
    role = lower(role),
    updated_at = (now() AT TIME ZONE 'utc')
WHERE role IS NOT NULL
  AND role IS DISTINCT FROM lower(role);

-- +goose Down
-- 大小写规范化不可安全区分历史小写值与本迁移改写值，回滚不改业务数据。
