-- +goose Up
-- 地址拆省市区 + 街道门牌：province/city/district 存中文名（前端 PCA 级联填入），address 仅街道门牌。

ALTER TABLE public.bas_party_address
    ADD COLUMN province text,
    ADD COLUMN city text,
    ADD COLUMN district text;

-- 存量：无区划时留空串，业务校验在新录/改时要求必填
UPDATE public.bas_party_address
SET province = COALESCE(province, ''),
    city = COALESCE(city, ''),
    district = COALESCE(district, '');

ALTER TABLE public.bas_party_address
    ALTER COLUMN province SET DEFAULT ''::text,
    ALTER COLUMN city SET DEFAULT ''::text,
    ALTER COLUMN district SET DEFAULT ''::text,
    ALTER COLUMN province SET NOT NULL,
    ALTER COLUMN city SET NOT NULL,
    ALTER COLUMN district SET NOT NULL;

-- +goose Down
ALTER TABLE public.bas_party_address
    DROP COLUMN IF EXISTS province,
    DROP COLUMN IF EXISTS city,
    DROP COLUMN IF EXISTS district;
