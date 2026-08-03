-- +goose Up
-- 对手地址：从属客户/供应商/内部公司的地点主数据（一址一方，无独立菜单）。
-- 用途 SHIPPING/OFFICE/OTHER；同主体同用途至多一个默认（部分唯一索引）。

CREATE TABLE public.bas_party_address (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    party_type text NOT NULL,
    party_id uuid NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    contact_name text,
    contact_phone text,
    address text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    remarks text,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    -- 库内小写 token，wire 大写（同 Party / 单据状态惯例）
    CONSTRAINT bas_party_address_party_type_check CHECK (party_type = ANY (ARRAY['customer'::text, 'supplier'::text, 'company'::text])),
    CONSTRAINT bas_party_address_purpose_check CHECK (purpose = ANY (ARRAY['shipping'::text, 'office'::text, 'other'::text])),
    CONSTRAINT bas_party_address_name_nonempty CHECK (length(btrim(name)) > 0),
    CONSTRAINT bas_party_address_address_nonempty CHECK (length(btrim(address)) > 0)
);

ALTER TABLE ONLY public.bas_party_address
    ADD CONSTRAINT bas_party_address_pkey PRIMARY KEY (id);

CREATE INDEX bas_party_address_party_idx
    ON public.bas_party_address USING btree (party_type, party_id);

-- 同主体同用途至多一条默认
CREATE UNIQUE INDEX bas_party_address_default_per_purpose_uidx
    ON public.bas_party_address (party_type, party_id, purpose)
    WHERE (is_default = true);

-- +goose Down
DROP TABLE IF EXISTS public.bas_party_address;
