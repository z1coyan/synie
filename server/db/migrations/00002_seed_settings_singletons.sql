-- +goose Up
-- Go baseline 是 schema-only pg_dump，不包含旧 Ecto 迁移创建四张设置表时写入的单行种子。
-- 只补缺失表行，保留从旧后端迁入的现有配置。
INSERT INTO sal_setting (id, inserted_at, updated_at)
SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
WHERE NOT EXISTS (SELECT 1 FROM sal_setting);

INSERT INTO mfg_setting (id, inserted_at, updated_at)
SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
WHERE NOT EXISTS (SELECT 1 FROM mfg_setting);

INSERT INTO acc_setting (id, inserted_at, updated_at)
SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
WHERE NOT EXISTS (SELECT 1 FROM acc_setting);

INSERT INTO sys_setting (id, inserted_at, updated_at)
SELECT gen_random_uuid(), now() AT TIME ZONE 'utc', now() AT TIME ZONE 'utc'
WHERE NOT EXISTS (SELECT 1 FROM sys_setting);

-- +goose Down
-- no-op：无法可靠区分本迁移补出的默认行和随后承载真实配置的单行，回滚不得删除配置。
SELECT 1;
