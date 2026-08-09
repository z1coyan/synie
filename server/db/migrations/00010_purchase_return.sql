-- 采购退货（源单行 + 手工行一票做全）：pur_return / pur_return_item 镜像 sal_return(_item)；
-- 条目挂 receipt_item_id（→ pur_receipt_item，可空=手工行）；
-- pur_receipt_item 冗余 returned_qty（已退数量受控投影）；pur_return_item 预建 reconciled_qty（对账票用）。

CREATE TABLE public.pur_return (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    return_no text NOT NULL,
    return_date date DEFAULT CURRENT_DATE NOT NULL,
    posting_date date,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    remarks text,
    status text DEFAULT 'draft'::text NOT NULL,
    audited_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    company_id uuid NOT NULL,
    warehouse_id uuid,
    debit_account_id uuid NOT NULL,
    credit_account_id uuid NOT NULL,
    created_by_id uuid,
    audited_by_id uuid,
    -- 原币与汇率：含手工行时全单换算口径（默认公司本币、汇率 1）
    currency_id uuid,
    exchange_rate numeric DEFAULT '1'::numeric,
    CONSTRAINT pur_return_pkey PRIMARY KEY (id),
    CONSTRAINT pur_return_party_pair CHECK (((party_type IS NULL) = (party_id IS NULL))),
    CONSTRAINT pur_return_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id),
    CONSTRAINT pur_return_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id),
    CONSTRAINT pur_return_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id),
    CONSTRAINT pur_return_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id),
    CONSTRAINT pur_return_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id),
    CONSTRAINT pur_return_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id),
    CONSTRAINT pur_return_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id)
);

CREATE UNIQUE INDEX pur_return_unique_return_no_index ON public.pur_return USING btree (company_id, return_no);

CREATE TABLE public.pur_return_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    -- 物料快照（源单行随入库条目带入；手工行随物料带入）
    material_code text,
    material_name text,
    material_spec text,
    customer_part_no text,
    unit_name text,
    -- 订单快照（复用入库条目的快照列口径；手工行按手填价税折算留痕，order_no 留空）
    order_no text,
    order_qty numeric,
    order_base_qty numeric,
    order_unit_name text,
    order_price numeric,
    order_amount numeric,
    order_base_price numeric,
    order_base_amount numeric,
    order_tax_rate numeric,
    order_currency_code text,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    return_id uuid NOT NULL,
    company_id uuid NOT NULL,
    receipt_item_id uuid,
    order_item_id uuid,
    material_id uuid,
    unit_id uuid,
    warehouse_id uuid,
    reconciled_qty numeric DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT pur_return_item_pkey PRIMARY KEY (id),
    CONSTRAINT pur_return_item_qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT pur_return_item_reconciled_qty_nonnegative CHECK ((reconciled_qty >= (0)::numeric)),
    CONSTRAINT pur_return_item_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.pur_return(id) ON DELETE CASCADE,
    CONSTRAINT pur_return_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id),
    CONSTRAINT pur_return_item_receipt_item_id_fkey FOREIGN KEY (receipt_item_id) REFERENCES public.pur_receipt_item(id),
    CONSTRAINT pur_return_item_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pur_order_item(id),
    CONSTRAINT pur_return_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id),
    CONSTRAINT pur_return_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id),
    CONSTRAINT pur_return_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id)
);

CREATE INDEX pur_return_item_return_id_index ON public.pur_return_item USING btree (return_id);
CREATE INDEX pur_return_item_receipt_item_id_index ON public.pur_return_item USING btree (receipt_item_id);

-- 已退数量受控投影：退货审核加、作废减；剩余可退 = base_qty − returned_qty
ALTER TABLE public.pur_receipt_item
    ADD COLUMN returned_qty numeric DEFAULT '0'::numeric NOT NULL,
    ADD CONSTRAINT pur_receipt_item_returned_qty_nonnegative CHECK ((returned_qty >= (0)::numeric));
