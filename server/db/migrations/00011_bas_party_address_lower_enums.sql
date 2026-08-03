-- +goose Up
-- 00010 若已按大写约束建表，改为小写 token（与 Party/单据惯例一致：库内小写、wire 大写）

ALTER TABLE public.bas_party_address DROP CONSTRAINT IF EXISTS bas_party_address_party_type_check;
ALTER TABLE public.bas_party_address DROP CONSTRAINT IF EXISTS bas_party_address_purpose_check;

UPDATE public.bas_party_address SET party_type = lower(party_type), purpose = lower(purpose);

ALTER TABLE public.bas_party_address
    ADD CONSTRAINT bas_party_address_party_type_check
    CHECK (party_type = ANY (ARRAY['customer'::text, 'supplier'::text, 'company'::text]));

ALTER TABLE public.bas_party_address
    ADD CONSTRAINT bas_party_address_purpose_check
    CHECK (purpose = ANY (ARRAY['shipping'::text, 'office'::text, 'other'::text]));

-- +goose Down
ALTER TABLE public.bas_party_address DROP CONSTRAINT IF EXISTS bas_party_address_party_type_check;
ALTER TABLE public.bas_party_address DROP CONSTRAINT IF EXISTS bas_party_address_purpose_check;
UPDATE public.bas_party_address SET party_type = upper(party_type), purpose = upper(purpose);
ALTER TABLE public.bas_party_address
    ADD CONSTRAINT bas_party_address_party_type_check
    CHECK (party_type = ANY (ARRAY['CUSTOMER'::text, 'SUPPLIER'::text, 'COMPANY'::text]));
ALTER TABLE public.bas_party_address
    ADD CONSTRAINT bas_party_address_purpose_check
    CHECK (purpose = ANY (ARRAY['SHIPPING'::text, 'OFFICE'::text, 'OTHER'::text]));
