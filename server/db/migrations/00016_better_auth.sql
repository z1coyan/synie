-- +goose Up
-- better-auth cookie 会话通道（与旧 JWT Bearer 双轨过渡）：
-- auth_* 四表对齐 better-auth schema（含 username 插件字段；snake_case 列名由实例 fields 映射）。
-- id 用 text：better-auth 自生成短串与回填 gen_random_uuid()::text 混存。
-- 时间列用 timestamptz（better-auth 以 JS Date 读写并比较过期时间，带时区最稳）。

CREATE TABLE public.auth_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    -- username 插件：username 存归一化小写（对齐 sys_user.username citext 语义），display_username 存原样
    username text,
    display_username text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX auth_user_unique_email_index ON public.auth_user USING btree (email);
CREATE UNIQUE INDEX auth_user_unique_username_index ON public.auth_user USING btree (username);

CREATE TABLE public.auth_session (
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamptz NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX auth_session_unique_token_index ON public.auth_session USING btree (token);
CREATE INDEX auth_session_user_id_idx ON public.auth_session USING btree (user_id);

CREATE TABLE public.auth_account (
    id text NOT NULL,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    account_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamptz,
    refresh_token_expires_at timestamptz,
    scope text,
    -- 仅 provider_id='credential' 行存密码（argon2id PHC，与 sys_user.hashed_password 同步写）
    password text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.auth_account
    ADD CONSTRAINT auth_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.auth_user(id) ON DELETE CASCADE;

CREATE INDEX auth_account_user_id_idx ON public.auth_account USING btree (user_id);
CREATE INDEX auth_account_provider_account_idx ON public.auth_account USING btree (provider_id, account_id);

CREATE TABLE public.auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);

CREATE INDEX auth_verification_identifier_idx ON public.auth_verification USING btree (identifier);

-- sys_user 增列：email 是 Logto 首登供给的匹配键（非空时唯一，忽略大小写）；auth_user_id 反链 better-auth 账号
ALTER TABLE public.sys_user ADD COLUMN email text;
ALTER TABLE public.sys_user ADD COLUMN auth_user_id text;

CREATE UNIQUE INDEX sys_user_unique_email_index
    ON public.sys_user USING btree (lower(email))
    WHERE (email IS NOT NULL);

ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_unique_auth_user_id UNIQUE (auth_user_id);
ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES public.auth_user(id);

-- backfill:begin（存量回填；幂等且容忍同名孤儿 auth_user——重复执行/脏库安全，集成测试复用本段）
-- 每个未关联的 sys_user 生成 auth_user（email 占位 <username>@users.synie.invalid）
INSERT INTO public.auth_user (id, name, email, email_verified, username, display_username, created_at, updated_at)
SELECT gen_random_uuid()::text,
       COALESCE(u.name, u.username::text),
       lower(u.username::text) || '@users.synie.invalid',
       false,
       lower(u.username::text),
       u.username::text,
       u.inserted_at AT TIME ZONE 'utc',
       u.updated_at AT TIME ZONE 'utc'
FROM public.sys_user u
WHERE u.auth_user_id IS NULL
ON CONFLICT DO NOTHING;

-- 按归一化 username 回链（同名孤儿一并收养；已被他人关联的跳过）
UPDATE public.sys_user u
SET auth_user_id = au.id
FROM public.auth_user au
WHERE u.auth_user_id IS NULL
  AND au.username = lower(u.username::text)
  AND NOT EXISTS (SELECT 1 FROM public.sys_user s WHERE s.auth_user_id = au.id);

-- credential 账户：password 复制存量 hashed_password（PHC 串互通，旧密码直接可登）
INSERT INTO public.auth_account (id, user_id, provider_id, account_id, password, created_at, updated_at)
SELECT gen_random_uuid()::text, u.auth_user_id, 'credential', u.auth_user_id, u.hashed_password,
       u.inserted_at AT TIME ZONE 'utc', u.updated_at AT TIME ZONE 'utc'
FROM public.sys_user u
WHERE u.auth_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.auth_account a
    WHERE a.user_id = u.auth_user_id AND a.provider_id = 'credential'
  );

-- 漂移收敛：已有 credential 行但密码与 sys_user 不一致的（仅重复执行场景），以 sys_user 为准
UPDATE public.auth_account a
SET password = u.hashed_password, updated_at = now()
FROM public.sys_user u
WHERE a.user_id = u.auth_user_id
  AND a.provider_id = 'credential'
  AND a.password IS DISTINCT FROM u.hashed_password;
-- backfill:end

-- +goose Down
ALTER TABLE public.sys_user DROP CONSTRAINT IF EXISTS sys_user_auth_user_id_fkey;
ALTER TABLE public.sys_user DROP CONSTRAINT IF EXISTS sys_user_unique_auth_user_id;
DROP INDEX IF EXISTS public.sys_user_unique_email_index;
ALTER TABLE public.sys_user DROP COLUMN IF EXISTS auth_user_id;
ALTER TABLE public.sys_user DROP COLUMN IF EXISTS email;
DROP TABLE IF EXISTS public.auth_verification;
DROP TABLE IF EXISTS public.auth_account;
DROP TABLE IF EXISTS public.auth_session;
DROP TABLE IF EXISTS public.auth_user;
