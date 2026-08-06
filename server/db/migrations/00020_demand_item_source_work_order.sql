-- +goose Up
-- 需求行新增「来源生产工单」来源列（工单物料需求派生，spec .scratch/work-order-material-demand）：
-- 与销售来源 sales_order_item_id 互斥（二选一或皆空）；派生行天然不参与销售占用。

ALTER TABLE public.mfg_demand_item
    ADD COLUMN source_work_order_id uuid;

ALTER TABLE ONLY public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_source_work_order_id_fkey FOREIGN KEY (source_work_order_id) REFERENCES public.mfg_work_order(id);

CREATE INDEX mfg_demand_item_source_work_order_id_index ON public.mfg_demand_item USING btree (source_work_order_id);

ALTER TABLE public.mfg_demand_item
    ADD CONSTRAINT mfg_demand_item_source_exclusive CHECK (NOT (sales_order_item_id IS NOT NULL AND source_work_order_id IS NOT NULL));

COMMENT ON COLUMN public.mfg_demand_item.source_work_order_id IS '来源生产工单（工单物料需求派生写入）：与销售来源互斥，派生行不参与销售占用';

-- +goose Down
ALTER TABLE public.mfg_demand_item DROP CONSTRAINT IF EXISTS mfg_demand_item_source_exclusive;
ALTER TABLE public.mfg_demand_item DROP COLUMN IF EXISTS source_work_order_id;
