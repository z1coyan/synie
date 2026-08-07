-- +goose Up
-- 仓库新增「编码」列：系统按编号规则生成（公司内唯一、创建后不可改），不接受手填。
-- 同时预置仓库/部门两条编号规则——必须走迁移而不是 setup 向导：
-- 首张公司在 setup 完成（completeBaseSeeds 播种规则）之前创建，
-- 公司创建同事务种子默认三仓即需取号，规则须随迁移先行就绪。
-- ADR: docs/系统架构/adr/2026-08-06-system-generated-numbering.md

ALTER TABLE public.inv_warehouse
    ADD COLUMN code text;

-- 存量回填（系统未上线，开发库可重建；仍按规则回填保证迁移可重放）：
-- 用 B(W)-9xxx 段避让计数器从 0001 起的新生编码，防唯一索引冲突。
UPDATE public.inv_warehouse w
SET code = 'B(W)-9' || lpad(s.rn::text, 3, '0')
FROM (
    SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY inserted_at, id) AS rn
    FROM public.inv_warehouse
) s
WHERE s.id = w.id;

ALTER TABLE public.inv_warehouse
    ALTER COLUMN code SET NOT NULL;

CREATE UNIQUE INDEX inv_warehouse_unique_code_per_company_index
    ON public.inv_warehouse USING btree (company_id, code);

COMMENT ON COLUMN public.inv_warehouse.code IS '仓库编码：系统按编号规则生成（公司内唯一），创建后不可改，不接受手填';

-- 编号规则预置（与 setup 的 seedNumberingRules 同口径，幂等跳过）
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
