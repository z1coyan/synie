-- +goose Up
-- BOM 生命周期 draft/active/inactive；需求安排与双投影地基（后续票共用本迁移）

-- —— BOM 状态 ——
ALTER TABLE public.mfg_bom
  ADD COLUMN status text DEFAULT 'active'::text NOT NULL;

ALTER TABLE public.mfg_bom
  ADD CONSTRAINT mfg_bom_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'inactive'::text]));

-- 存量 BOM 保持可选（active）；新创建默认由应用写 draft
COMMENT ON COLUMN public.mfg_bom.status IS 'draft|active|inactive；仅 active 可被新工单/委外选入；仅 draft 可物理删除';

-- —— 需求行：已安排/已完成投影 ——
ALTER TABLE public.mfg_demand_item
  ADD COLUMN arranged_qty numeric DEFAULT '0'::numeric NOT NULL,
  ADD COLUMN completed_qty numeric DEFAULT '0'::numeric NOT NULL;

ALTER TABLE public.mfg_demand_item
  ADD CONSTRAINT arranged_qty_nonnegative CHECK (arranged_qty >= (0)::numeric),
  ADD CONSTRAINT completed_qty_nonnegative CHECK (completed_qty >= (0)::numeric);

-- 履约方式改为可空（新行不再写；存量保留至回填后可再 drop）
ALTER TABLE public.mfg_demand_item
  ALTER COLUMN fulfillment_method DROP NOT NULL,
  ALTER COLUMN fulfillment_method DROP DEFAULT;

-- —— 安排事实表 ——
CREATE TABLE public.mfg_demand_arrangement (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    demand_item_id uuid NOT NULL REFERENCES public.mfg_demand_item(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.bas_company(id),
    arrangement_type text NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    work_order_id uuid REFERENCES public.mfg_work_order(id) ON DELETE CASCADE,
    purchase_order_item_id uuid,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_demand_arrangement_type_check CHECK (
      arrangement_type = ANY (ARRAY[
        'make'::text, 'purchase'::text, 'outsource'::text, 'stock'::text, 'close'::text
      ])
    ),
    CONSTRAINT mfg_demand_arrangement_qty_positive CHECK (qty > (0)::numeric),
    CONSTRAINT mfg_demand_arrangement_base_qty_nonnegative CHECK (base_qty >= (0)::numeric),
    CONSTRAINT mfg_demand_arrangement_downstream_shape CHECK (
      (
        arrangement_type = 'make'
        AND work_order_id IS NOT NULL
        AND purchase_order_item_id IS NULL
      )
      OR (
        arrangement_type = ANY (ARRAY['purchase'::text, 'outsource'::text])
        AND purchase_order_item_id IS NOT NULL
        AND work_order_id IS NULL
      )
      OR (
        arrangement_type = ANY (ARRAY['stock'::text, 'close'::text])
        AND work_order_id IS NULL
        AND purchase_order_item_id IS NULL
      )
    )
);

CREATE INDEX mfg_demand_arrangement_item_idx
  ON public.mfg_demand_arrangement USING btree (demand_item_id);

CREATE UNIQUE INDEX mfg_demand_arrangement_work_order_uidx
  ON public.mfg_demand_arrangement USING btree (work_order_id)
  WHERE work_order_id IS NOT NULL;

CREATE UNIQUE INDEX mfg_demand_arrangement_po_item_uidx
  ON public.mfg_demand_arrangement USING btree (purchase_order_item_id)
  WHERE purchase_order_item_id IS NOT NULL;

-- 工单：允许多张挂同一需求行（去掉一活跃一行唯一）
DROP INDEX IF EXISTS public.mfg_work_order_active_demand_item_index;

CREATE INDEX mfg_work_order_demand_item_idx
  ON public.mfg_work_order USING btree (demand_item_id)
  WHERE status <> 'voided'::text;

-- 工单可选 BOM 来源留痕
ALTER TABLE public.mfg_work_order
  ADD COLUMN bom_id uuid REFERENCES public.mfg_bom(id) ON DELETE SET NULL;

-- +goose Down
DROP INDEX IF EXISTS public.mfg_work_order_demand_item_idx;
CREATE UNIQUE INDEX mfg_work_order_active_demand_item_index
  ON public.mfg_work_order USING btree (demand_item_id) WHERE (status <> 'voided'::text);

ALTER TABLE public.mfg_work_order DROP COLUMN IF EXISTS bom_id;

DROP TABLE IF EXISTS public.mfg_demand_arrangement;

ALTER TABLE public.mfg_demand_item
  DROP CONSTRAINT IF EXISTS arranged_qty_nonnegative,
  DROP CONSTRAINT IF EXISTS completed_qty_nonnegative,
  DROP COLUMN IF EXISTS arranged_qty,
  DROP COLUMN IF EXISTS completed_qty;

ALTER TABLE public.mfg_demand_item
  ALTER COLUMN fulfillment_method SET DEFAULT 'make'::text,
  ALTER COLUMN fulfillment_method SET NOT NULL;

ALTER TABLE public.mfg_bom DROP CONSTRAINT IF EXISTS mfg_bom_status_check;
ALTER TABLE public.mfg_bom DROP COLUMN IF EXISTS status;

-- Note: work order BOM snapshot tables added in 00006
