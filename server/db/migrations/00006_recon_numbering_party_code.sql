-- 销售/采购对账单默认编号中间段改为对手编号（party.code）。
-- 替换历史错误默认（posting_date/业务日期）与 00005 的仅前缀+序号形态；
-- 仅当 segments 仍等于已知默认时覆写，不碰管理员已改过的规则。

-- 销售：posting_date 默认 → party.code
UPDATE public.sys_numbering_rule
SET segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"S(R)-"},{"type":"field","field":"party.code","label":"客户编号"},{"type":"text","value":"-"},{"type":"seq","padding":4}]'::jsonb
      )
    ),
    updated_at = now()
WHERE resource = 'sales.reconciliation'
  AND segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"S(R)-"},{"type":"field","field":"posting_date","format":"YYYYMMDD","label":"业务日期"},{"type":"text","value":"-"},{"type":"seq","padding":4}]'::jsonb
      )
    );

-- 销售：00005 仅前缀+序号 → party.code
UPDATE public.sys_numbering_rule
SET segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"S(R)-"},{"type":"field","field":"party.code","label":"客户编号"},{"type":"text","value":"-"},{"type":"seq","padding":4}]'::jsonb
      )
    ),
    updated_at = now()
WHERE resource = 'sales.reconciliation'
  AND segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"S(R)-"},{"type":"seq","padding":4}]'::jsonb
      )
    );

-- 采购：posting_date 默认 → party.code
UPDATE public.sys_numbering_rule
SET segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"P(C)-"},{"type":"field","field":"party.code","label":"供应商编号"},{"type":"text","value":"-"},{"type":"seq","padding":4}]'::jsonb
      )
    ),
    updated_at = now()
WHERE resource = 'purchase.reconciliation'
  AND segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"P(C)-"},{"type":"field","field":"posting_date","format":"YYYYMMDD","label":"业务日期"},{"type":"text","value":"-"},{"type":"seq","padding":4}]'::jsonb
      )
    );

-- 采购：00005 仅前缀+序号 → party.code
UPDATE public.sys_numbering_rule
SET segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"P(C)-"},{"type":"field","field":"party.code","label":"供应商编号"},{"type":"text","value":"-"},{"type":"seq","padding":4}]'::jsonb
      )
    ),
    updated_at = now()
WHERE resource = 'purchase.reconciliation'
  AND segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"P(C)-"},{"type":"seq","padding":4}]'::jsonb
      )
    );
