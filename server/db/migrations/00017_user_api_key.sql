-- 个人 API 密钥：用户自助签发、可撤销的程序访问凭证（AI 参与模式第一阶段）。
-- 明文只在创建响应出现一次；库内只存 SHA-256。删用户级联作废。

CREATE TABLE public.sys_user_api_key (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    token_hint text NOT NULL,
    expires_at timestamp without time zone,
    last_used_at timestamp without time zone,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    CONSTRAINT sys_user_api_key_name_length CHECK (
        char_length(btrim(name)) >= 1 AND char_length(name) <= 64
    )
);

ALTER TABLE ONLY public.sys_user_api_key
    ADD CONSTRAINT sys_user_api_key_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sys_user_api_key
    ADD CONSTRAINT sys_user_api_key_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.sys_user(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX sys_user_api_key_token_hash_index
    ON public.sys_user_api_key USING btree (token_hash);

CREATE INDEX sys_user_api_key_user_id_index
    ON public.sys_user_api_key USING btree (user_id);

COMMENT ON TABLE public.sys_user_api_key IS '个人 API 密钥：哈希落库，明文不回读';
COMMENT ON COLUMN public.sys_user_api_key.token_hash IS '完整明文的 SHA-256 hex';
COMMENT ON COLUMN public.sys_user_api_key.token_hint IS '展示用前缀（不含密钥体）';
