-- +goose Up
-- 仓库/部门编号规则的「纯种子」副本：与 00022 尾部 INSERT 同口径、幂等跳过。
-- 单独成文件的原因：db:reset 清空业务表后按 RESEED_MIGRATIONS 重放纯种子迁移，
-- 而 00022 混有 DDL（ALTER TABLE）不可重放——缺失本种子会导致 setup 向导
-- 首张公司创建同事务种子三仓时无规则可取号（「创建默认仓库失败」）。
-- 00022 已在各库应用、不再改动；新建库先经 00022 播种，本文件幂等跳过。
INSERT INTO public.sys_numbering_rule (resource, name, segments, per_company, enabled)
SELECT 'base.warehouse', '仓库编号',
       ARRAY(SELECT value FROM jsonb_array_elements('[{"type":"text","value":"B(W)-"},{"type":"seq","padding":4}]'::jsonb)),
       true, true
WHERE NOT EXISTS (SELECT 1 FROM public.sys_numbering_rule WHERE resource = 'base.warehouse');

INSERT INTO public.sys_numbering_rule (resource, name, segments, per_company, enabled)
SELECT 'sys.department', '部门编码',
       ARRAY(SELECT value FROM jsonb_array_elements('[{"type":"text","value":"B(D)-"},{"type":"seq","padding":4}]'::jsonb)),
       true, true
WHERE NOT EXISTS (SELECT 1 FROM public.sys_numbering_rule WHERE resource = 'sys.department');
