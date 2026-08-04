-- +goose Up
-- 履约条目行仓放宽：非库存类（VIRTUAL/ASSET）行不写库存分录，行仓可空；STOCK 行仍由应用层强制必填。

ALTER TABLE public.sal_delivery_item
    ALTER COLUMN warehouse_id DROP NOT NULL;

ALTER TABLE public.pur_receipt_item
    ALTER COLUMN warehouse_id DROP NOT NULL;

-- +goose Down
ALTER TABLE public.sal_delivery_item
    ALTER COLUMN warehouse_id SET NOT NULL;

ALTER TABLE public.pur_receipt_item
    ALTER COLUMN warehouse_id SET NOT NULL;
