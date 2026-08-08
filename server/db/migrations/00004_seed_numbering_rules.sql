-- 编号规则纯种子（幂等）：仓库/部门规则必须在 setup 向导之前由迁移就绪——
-- 首张公司在 setup 完成前创建，公司创建同事务种子默认三仓即需取号。
-- 物料编号规则由 setup 服务播种（resource=base.material）。
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
