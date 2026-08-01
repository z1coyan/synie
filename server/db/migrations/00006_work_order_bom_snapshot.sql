-- +goose Up
-- 生产工单 BOM 快照子表（配料/工艺路线/副产品）

CREATE TABLE public.mfg_work_order_component (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    work_order_id uuid NOT NULL REFERENCES public.mfg_work_order(id) ON DELETE CASCADE,
    material_id uuid NOT NULL REFERENCES public.inv_material(id),
    unit_id uuid NOT NULL REFERENCES public.bas_unit(id),
    quantity numeric NOT NULL,
    loss_rate numeric,
    note text,
    idx bigint NOT NULL DEFAULT 0,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_wo_component_qty_positive CHECK (quantity > (0)::numeric)
);

CREATE TABLE public.mfg_work_order_route (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    work_order_id uuid NOT NULL REFERENCES public.mfg_work_order(id) ON DELETE CASCADE,
    operation_id uuid NOT NULL REFERENCES public.mfg_operation(id),
    seq bigint NOT NULL,
    requirement text,
    is_outsourced boolean DEFAULT false NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);

CREATE TABLE public.mfg_work_order_byproduct (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    work_order_id uuid NOT NULL REFERENCES public.mfg_work_order(id) ON DELETE CASCADE,
    material_id uuid NOT NULL REFERENCES public.inv_material(id),
    unit_id uuid NOT NULL REFERENCES public.bas_unit(id),
    quantity numeric NOT NULL,
    note text,
    idx bigint NOT NULL DEFAULT 0,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_wo_byproduct_qty_positive CHECK (quantity > (0)::numeric)
);

CREATE INDEX mfg_wo_component_wo_idx ON public.mfg_work_order_component (work_order_id);
CREATE INDEX mfg_wo_route_wo_idx ON public.mfg_work_order_route (work_order_id);
CREATE INDEX mfg_wo_byproduct_wo_idx ON public.mfg_work_order_byproduct (work_order_id);

-- +goose Down
DROP TABLE IF EXISTS public.mfg_work_order_byproduct;
DROP TABLE IF EXISTS public.mfg_work_order_route;
DROP TABLE IF EXISTS public.mfg_work_order_component;
