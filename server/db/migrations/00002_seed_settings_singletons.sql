-- 四张设置表的单行种子（schema-only 基线不含数据）。幂等：只补缺失行，不覆盖已有配置。
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

