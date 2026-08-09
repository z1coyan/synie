-- 销售退货（源单行）：sal_return / sal_return_item 镜像 sal_delivery(_item)；
-- 条目多 delivery_item_id（→ sal_delivery_item，本票必填；为 #57 手工行预留可空与快照列可空），无装箱子树；
-- sal_delivery_item 冗余 returned_qty（已退数量受控投影）；sal_return_item 预建 reconciled_qty（对账票用）。

CREATE TABLE public.sal_return (
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
    -- 原币与汇率：本票按订单快照币种校验一致；为 #57 手工行预留全单换算口径
    currency_id uuid,
    exchange_rate numeric DEFAULT '1'::numeric,
    CONSTRAINT sal_return_pkey PRIMARY KEY (id),
    CONSTRAINT sal_return_party_pair CHECK (((party_type IS NULL) = (party_id IS NULL))),
    CONSTRAINT sal_return_audited_by_id_fkey FOREIGN KEY (audited_by_id) REFERENCES public.sys_user(id),
    CONSTRAINT sal_return_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id),
    CONSTRAINT sal_return_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.sys_user(id),
    CONSTRAINT sal_return_credit_account_id_fkey FOREIGN KEY (credit_account_id) REFERENCES public.bas_account(id),
    CONSTRAINT sal_return_debit_account_id_fkey FOREIGN KEY (debit_account_id) REFERENCES public.bas_account(id),
    CONSTRAINT sal_return_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id),
    CONSTRAINT sal_return_currency_id_fkey FOREIGN KEY (currency_id) REFERENCES public.bas_currency(id)
);

CREATE UNIQUE INDEX sal_return_unique_return_no_index ON public.sal_return USING btree (company_id, return_no);

CREATE TABLE public.sal_return_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    -- 物料快照（本票源单行随发货条目带入；为手工行预留可空）
    material_code text,
    material_name text,
    material_spec text,
    customer_part_no text,
    unit_name text,
    -- 订单快照（复用发货条目的快照列口径；手工行可空）
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
    delivery_item_id uuid,
    order_item_id uuid,
    material_id uuid,
    unit_id uuid,
    warehouse_id uuid,
    reconciled_qty numeric DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT sal_return_item_pkey PRIMARY KEY (id),
    CONSTRAINT sal_return_item_qty_positive CHECK ((qty > (0)::numeric)),
    CONSTRAINT sal_return_item_reconciled_qty_nonnegative CHECK ((reconciled_qty >= (0)::numeric)),
    CONSTRAINT sal_return_item_return_id_fkey FOREIGN KEY (return_id) REFERENCES public.sal_return(id) ON DELETE CASCADE,
    CONSTRAINT sal_return_item_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id),
    CONSTRAINT sal_return_item_delivery_item_id_fkey FOREIGN KEY (delivery_item_id) REFERENCES public.sal_delivery_item(id),
    CONSTRAINT sal_return_item_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.sal_order_item(id),
    CONSTRAINT sal_return_item_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id),
    CONSTRAINT sal_return_item_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id),
    CONSTRAINT sal_return_item_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.inv_warehouse(id)
);

CREATE INDEX sal_return_item_return_id_index ON public.sal_return_item USING btree (return_id);
CREATE INDEX sal_return_item_delivery_item_id_index ON public.sal_return_item USING btree (delivery_item_id);

-- 已退数量受控投影：退货审核加、作废减；剩余可退 = base_qty − returned_qty
ALTER TABLE public.sal_delivery_item
    ADD COLUMN returned_qty numeric DEFAULT '0'::numeric NOT NULL,
    ADD CONSTRAINT sal_delivery_item_returned_qty_nonnegative CHECK ((returned_qty >= (0)::numeric));
