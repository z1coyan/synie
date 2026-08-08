-- 修复销售/采购对账单预置编号规则：误用 posting_date（标为「业务日期」）。
-- 对账单头无业务日期；posting_date 仅赠样结单时写入过账日，创建取号时恒为空，
-- 日期段静默跳过会得到 S(R)--0001 / P(C)--0001。
-- 仅当 segments 仍等于错误默认时覆写，不碰管理员已改过的规则。

UPDATE public.sys_numbering_rule
SET segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"S(R)-"},{"type":"seq","padding":4}]'::jsonb
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

UPDATE public.sys_numbering_rule
SET segments = ARRAY(
      SELECT value
      FROM jsonb_array_elements(
        '[{"type":"text","value":"P(C)-"},{"type":"seq","padding":4}]'::jsonb
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
