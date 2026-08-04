-- +goose Up
-- 模具设计：生产域独立实体，1:1 挂物料（material_id UNIQUE）；建模具时系统同事务自动建资产类物料。
-- 模具物料分类挂生产设置（首例单行设置存引用列，不加 FK 约束，对齐 sal_company_account_default 先例）。

ALTER TABLE public.mfg_setting
    ADD COLUMN mold_category_id uuid;

CREATE TABLE public.mfg_mold_design (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mold_type text NOT NULL,
    material_id uuid NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT mfg_mold_design_pkey PRIMARY KEY (id),
    CONSTRAINT mfg_mold_design_material_unique UNIQUE (material_id),
    CONSTRAINT mfg_mold_design_material_fk FOREIGN KEY (material_id) REFERENCES public.inv_material(id),
    CONSTRAINT mfg_mold_design_type_check CHECK (mold_type = ANY (ARRAY['STAMPING', 'FORMING', 'POSITIONING', 'OTHER']))
);

-- +goose Down
DROP TABLE IF EXISTS public.mfg_mold_design;

ALTER TABLE public.mfg_setting
    DROP COLUMN IF EXISTS mold_category_id;
