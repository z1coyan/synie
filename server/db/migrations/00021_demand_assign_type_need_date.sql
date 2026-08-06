-- +goose Up
-- 履约需求单头新增「指派类型」（纯路由声明：采购/生产/库存/关闭，不占量不联动状态机）
-- 与单头「需求日」（行 need_date 的默认值来源）；需求行 need_date 收紧为必填。
-- 联动不变量：assign_type=make ⇔ assigned_dept_id 非空（DB CHECK 兜底，service 层先拦）。
-- ADR: docs/adr/2026-08-06-demand-assign-type.md

ALTER TABLE public.mfg_demand
    ADD COLUMN assign_type text,
    ADD COLUMN need_date date;

-- 存量回填（系统未上线，开发库可重建；仍按规则回填保证迁移可重放）：
-- 已填下发车间 → 生产(make)；未下发 → 采购(purchase)。
UPDATE public.mfg_demand
SET assign_type = CASE WHEN assigned_dept_id IS NOT NULL THEN 'make' ELSE 'purchase' END
WHERE assign_type IS NULL;

ALTER TABLE public.mfg_demand
    ALTER COLUMN assign_type SET NOT NULL;

ALTER TABLE public.mfg_demand
    ADD CONSTRAINT mfg_demand_assign_type_values
    CHECK (assign_type IN ('purchase', 'make', 'stock', 'close'));

ALTER TABLE public.mfg_demand
    ADD CONSTRAINT mfg_demand_assign_dept_link
    CHECK ((assign_type = 'make') = (assigned_dept_id IS NOT NULL));

COMMENT ON COLUMN public.mfg_demand.assign_type IS '指派类型（purchase/make/stock/close）：纯路由声明，不占量不约束行级安排；make 时下发车间必填，其余类型必须为空';
COMMENT ON COLUMN public.mfg_demand.need_date IS '单头需求日：新增需求行的行需求日默认值，「批量带入」可刷新到全部既有行；改单头不追溯既有行';

-- 需求行 need_date 必填：空值先回填单头需求日（无则业务日期），再改约束。
UPDATE public.mfg_demand_item i
SET need_date = COALESCE(d.need_date, d.demand_date)
FROM public.mfg_demand d
WHERE i.demand_id = d.id AND i.need_date IS NULL;

ALTER TABLE public.mfg_demand_item
    ALTER COLUMN need_date SET NOT NULL;

-- +goose Down
ALTER TABLE public.mfg_demand_item ALTER COLUMN need_date DROP NOT NULL;
ALTER TABLE public.mfg_demand DROP CONSTRAINT IF EXISTS mfg_demand_assign_dept_link;
ALTER TABLE public.mfg_demand DROP CONSTRAINT IF EXISTS mfg_demand_assign_type_values;
ALTER TABLE public.mfg_demand DROP COLUMN IF EXISTS need_date;
ALTER TABLE public.mfg_demand DROP COLUMN IF EXISTS assign_type;
