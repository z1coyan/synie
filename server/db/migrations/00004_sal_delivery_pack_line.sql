-- +goose Up
-- 销售发货装箱清单：发货单下可选子表（纯实物复核层，不落库存/总账/投影）。
-- 行＝箱号＋物料＋单位＋数量＋base_qty＋行备注＋物料文本快照五字段；
-- 箱号必填自由文本（行上分组列，不建箱头实体）；随单级联删除。
CREATE TABLE public.sal_delivery_pack_line (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
    box_no text NOT NULL,
    qty numeric NOT NULL,
    base_qty numeric DEFAULT '0'::numeric NOT NULL,
    material_code text NOT NULL,
    material_name text NOT NULL,
    material_spec text,
    customer_part_no text,
    unit_name text NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    delivery_id uuid NOT NULL,
    company_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT box_no_not_blank CHECK ((btrim(box_no) <> ''::text)),
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.sal_delivery(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);

-- +goose Down
DROP TABLE public.sal_delivery_pack_line;
