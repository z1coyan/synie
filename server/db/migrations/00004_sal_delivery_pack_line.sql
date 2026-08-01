-- +goose Up
-- 销售发货装箱清单：发货单下可选子表（纯实物复核层，不落库存/总账/投影）。
-- 箱/行两级：装箱箱＝单内自增箱号（系统生成不可手改）；装箱行＝所属箱＋物料＋单位＋数量＋base_qty＋行备注＋物料文本快照五字段。
-- 箱随单级联删除、删箱级联其装箱行。（2026-07-29 箱由行上自由文本箱号升格为实体，见 ADR 2026-07-29 装箱箱实体与重量口径。）
CREATE TABLE public.sal_delivery_pack_box (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    box_no bigint NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    delivery_id uuid NOT NULL,
    company_id uuid NOT NULL
);

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_delivery_box_no_key UNIQUE (delivery_id, box_no);

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);

ALTER TABLE ONLY public.sal_delivery_pack_box
    ADD CONSTRAINT sal_delivery_pack_box_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.sal_delivery(id) ON DELETE CASCADE;

CREATE TABLE public.sal_delivery_pack_line (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idx bigint NOT NULL,
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
    pack_box_id uuid NOT NULL,
    material_id uuid NOT NULL,
    unit_id uuid NOT NULL,
    CONSTRAINT qty_positive CHECK ((qty > (0)::numeric))
);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.sal_delivery(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_pack_box_id_fkey FOREIGN KEY (pack_box_id) REFERENCES public.sal_delivery_pack_box(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_material_id_fkey FOREIGN KEY (material_id) REFERENCES public.inv_material(id);

ALTER TABLE ONLY public.sal_delivery_pack_line
    ADD CONSTRAINT sal_delivery_pack_line_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.bas_unit(id);

-- +goose Down
DROP TABLE public.sal_delivery_pack_line;
DROP TABLE public.sal_delivery_pack_box;
