-- +goose Up
-- 物料权限码已由 inv.material 改名 base.material，编号目录 prefix 恒等于 permissionPrefix：
-- 将编号规则的绑定资源同步改名。计数器（sys_numbering_counter）按 rule_id + scope_key
-- 关联，scope_key 由公司编码/段文本组成、不含资源串，无需更新。

UPDATE public.sys_numbering_rule
SET
    resource = 'base.material',
    updated_at = (now() AT TIME ZONE 'utc')
WHERE resource = 'inv.material';

-- +goose Down
UPDATE public.sys_numbering_rule
SET
    resource = 'inv.material',
    updated_at = (now() AT TIME ZONE 'utc')
WHERE resource = 'base.material';
