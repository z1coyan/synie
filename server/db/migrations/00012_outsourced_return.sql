-- 委外退货（纯数量单）：pur_outsourced_return / pur_outsourced_return_item。
-- 与销售/采购退货的最大不对称（ADR 2026-08-09）：无金额、无过账日期、无表底科目、
-- 不过总账、不进对账（条目无 reconciled_qty）；不回补外协仓材料、不退副产物。
-- 条目锚点 outsourced_receipt_item_id（→ pur_outsourced_receipt_item，可空=手工行，
-- 手工行仅物料/单位/数量/行仓）；pur_outsourced_receipt_item 冗余 returned_qty（CHECK ≥0）。

CREATE TABLE public.pur_outsourced_return (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    return_no text NOT NULL,
    return_date date DEFAULT CURRENT_DATE NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    created_by_id uuid,
    audited_by_id uuid,
    CONSTRAINT pur_outsourced_return_pkey PRIMARY KEY (id),
    CONSTRAINT pur_outsourced_return_party_pair CHECK (((party_type IS NULL) = (party_id IS NULL))),
    CONSTRAINT pur_outsourced_return_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id),
    CONSTRAINT pur_outsourced_return_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id),
    CONSTRAINT pur_outsourced_return_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id),
    CONSTRAINT pur_outsourced_return_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id)
);

CREATE UNIQUE INDEX pur_outsourced_return_unique_return_no_index
    ON public.pur_outsourced_return USING btree (company_id, return_no);

CREATE TABLE public.pur_outsourced_return_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    -- 物料快照（源单行随委外入库条目带入；手工行随物料带入）
    material_code text,
    material_name text,
    material_spec text,
    customer_part_no text,
    unit_name text,
    -- 订单数量快照（纯展示口径；手工行留空）
    order_no text,
    order_qty numeric,
    order_base_qty numeric,
    order_unit_name text,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    return_id uuid NOT NULL,
    company_id uuid NOT NULL,
    outsourced_receipt_item_id uuid,
    order_item_id uuid,
    material_id uuid,
    unit_id uuid,
    warehouse_id uuid,
    CONSTRAINT pur_outsourced_return_item_pkey PRIMARY KEY (id),
    CONSTRAINT pur_outsourced_return_item_qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT pur_outsourced_return_item_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.pur_outsourced_return(id) ON DELETE CASCADE,
    CONSTRAINT pur_outsourced_return_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id),
    CONSTRAINT pur_outsourced_return_item_ocr_item_fkey FOREIGN KEY (outsourced_receipt_item_id) REFERENCES public.pur_outsourced_receipt_item(id),
    CONSTRAINT pur_outsourced_return_item_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pur_order_item(id),
    CONSTRAINT pur_outsourced_return_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id),
    CONSTRAINT pur_outsourced_return_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id),
    CONSTRAINT pur_outsourced_return_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id)
);

CREATE INDEX pur_outsourced_return_item_return_id_index
    ON public.pur_outsourced_return_item USING btree (return_id);
CREATE INDEX pur_outsourced_return_item_ocr_item_index
    ON public.pur_outsourced_return_item USING btree (outsourced_receipt_item_id);

-- 已退数量受控投影：委外退货审核加、作废减；剩余可退 = base_qty − returned_qty
ALTER TABLE public.pur_outsourced_receipt_item
    ADD COLUMN returned_qty numeric DEFAULT '0'::numeric NOT NULL,
    ADD CONSTRAINT pur_outsourced_receipt_item_returned_qty_nonnegative CHECK ((returned_qty >= (0)::numeric));
