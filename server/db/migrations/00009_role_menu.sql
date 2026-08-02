-- +goose Up
-- 角色菜单白名单：按角色配置「可见菜单集合」（角色无任何行 = 未启用限制 = 全可见）。
-- 形态对齐 sys_role_permission；只建表不写行（老环境内置角色维持全可见，sales 白名单只随初始化向导种子）。

CREATE TABLE public.sys_role_menu (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    menu_code text NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);

ALTER TABLE ONLY public.sys_role_menu
    ADD CONSTRAINT sys_role_menu_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX sys_role_menu_unique_role_menu_index ON public.sys_role_menu USING btree (role_id, menu_code);

ALTER TABLE ONLY public.sys_role_menu
    ADD CONSTRAINT sys_role_menu_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.sys_role(id);

COMMENT ON TABLE public.sys_role_menu IS '角色菜单白名单：每行=该角色可见的一个叶子菜单 code；角色无行=不限制（全可见）';

-- +goose Down
DROP TABLE IF EXISTS public.sys_role_menu;
