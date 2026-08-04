-- +goose Up
-- 物料类型三分：STOCK 库存（默认，存量归入）/ VIRTUAL 虚拟（服务等，不进库存）/ ASSET 资产（模具、设备等，按资产管理、不进库存数量账）。

ALTER TABLE public.inv_material
    ADD COLUMN material_type text NOT NULL DEFAULT 'STOCK';

ALTER TABLE public.inv_material
    ADD CONSTRAINT inv_material_material_type_check
    CHECK (material_type = ANY (ARRAY['STOCK', 'VIRTUAL', 'ASSET']));

-- +goose Down
ALTER TABLE public.inv_material
    DROP CONSTRAINT IF EXISTS inv_material_material_type_check,
    DROP COLUMN IF EXISTS material_type;
