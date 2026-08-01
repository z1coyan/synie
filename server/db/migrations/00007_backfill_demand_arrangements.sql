-- +goose Up
-- 存量回填：历史工单 → 生产安排；已审核采购/委外条目 → 采购/委外安排；重算已安排/已完成投影

-- 未作废工单补生产安排（已有安排行则跳过）
INSERT INTO public.mfg_demand_arrangement (
    demand_item_id,
    company_id,
    arrangement_type,
    qty,
    base_qty,
    work_order_id
)
SELECT
    wo.demand_item_id,
    wo.company_id,
    'make',
    wo.qty,
    wo.base_qty,
    wo.id
FROM public.mfg_work_order wo
WHERE wo.status <> 'voided'
  AND NOT EXISTS (
    SELECT 1
    FROM public.mfg_demand_arrangement a
    WHERE a.work_order_id = wo.id
  );

-- 已审核采购/委外订单条目（挂需求行）补对应安排
INSERT INTO public.mfg_demand_arrangement (
    demand_item_id,
    company_id,
    arrangement_type,
    qty,
    base_qty,
    purchase_order_item_id
)
SELECT
    i.demand_line_id,
    i.company_id,
    CASE WHEN o.is_outsourced THEN 'outsource' ELSE 'purchase' END,
    i.qty,
    i.base_qty,
    i.id
FROM public.pur_order_item i
JOIN public.pur_order o ON o.id = i.order_id
WHERE i.demand_line_id IS NOT NULL
  AND lower(o.status) = 'audited'
  AND NOT EXISTS (
    SELECT 1
    FROM public.mfg_demand_arrangement a
    WHERE a.purchase_order_item_id = i.id
  );

-- 按安排事实 + 工单已入 + 采购已收 重算行投影与状态
-- （关闭/库存安排同时贡献已安排与已完成；容差默认 0，与 recomputeDemandItemProjections 一致）
WITH sums AS (
  SELECT
    di.id,
    di.base_qty,
    coalesce((
      SELECT sum(a.base_qty)
      FROM public.mfg_demand_arrangement a
      WHERE a.demand_item_id = di.id
    ), 0) AS arranged,
    coalesce((
      SELECT sum(wo.received_base_qty)
      FROM public.mfg_work_order wo
      WHERE wo.demand_item_id = di.id
        AND wo.status <> 'voided'
    ), 0)
    + di.received_qty
    + coalesce((
      SELECT sum(a.base_qty)
      FROM public.mfg_demand_arrangement a
      WHERE a.demand_item_id = di.id
        AND a.arrangement_type IN ('stock', 'close')
    ), 0) AS completed
  FROM public.mfg_demand_item di
)
UPDATE public.mfg_demand_item di
SET
  arranged_qty = s.arranged,
  completed_qty = s.completed,
  status = CASE
    WHEN s.arranged >= s.base_qty AND s.completed >= s.base_qty THEN 'completed'
    WHEN s.arranged > 0 THEN 'scheduled'
    ELSE 'pending'
  END,
  updated_at = (now() AT TIME ZONE 'utc')
FROM sums s
WHERE di.id = s.id
  AND (
    di.arranged_qty IS DISTINCT FROM s.arranged
    OR di.completed_qty IS DISTINCT FROM s.completed
    OR di.status IS DISTINCT FROM (
      CASE
        WHEN s.arranged >= s.base_qty AND s.completed >= s.base_qty THEN 'completed'
        WHEN s.arranged > 0 THEN 'scheduled'
        ELSE 'pending'
      END
    )
  );

-- +goose Down
-- 回填不可逆：down 仅清空由下游倒写的安排行并清零投影（手工库存/关闭安排一并清除）
DELETE FROM public.mfg_demand_arrangement;

UPDATE public.mfg_demand_item
SET
  arranged_qty = 0,
  completed_qty = 0,
  status = CASE WHEN status = 'completed' THEN 'pending' ELSE status END,
  updated_at = (now() AT TIME ZONE 'utc');
