-- +goose Up
-- 权限重构：封闭谓词代数的存储地基（ADR 2026-08-04，spec .scratch/authz-rewrite）。
-- 四件事：授权行加数据范围、角色加全域旗标、新建部门树、用户挂部门。
-- 通配符同批取消：存量 '*' 授权行折叠为 sys_role.grants_all。

-- 1) 授权 = (role, code, scope) 三元组
--    scope 取值 all/dept_tree/dept/self；granted 为预留值，第一期写侧拒绝。
ALTER TABLE public.sys_role_permission
    ADD COLUMN scope text DEFAULT 'all' NOT NULL;

ALTER TABLE public.sys_role_permission
    ADD CONSTRAINT sys_role_permission_scope_check
    CHECK (scope IN ('all', 'dept_tree', 'dept', 'self'));

COMMENT ON COLUMN public.sys_role_permission.scope IS '数据范围：all/dept_tree/dept/self（granted 预留、第一期拒写）；多角色同码取格上最大';

-- 2) 全域授权旗标：装配 Actor 时展开为全目录 all 范围（新权限码自动覆盖）
ALTER TABLE public.sys_role
    ADD COLUMN grants_all boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.sys_role.grants_all IS '全域授权旗标：持有即覆盖全部权限码（all 范围）；内置 admin 用此旗标取代 * 通配行';

-- 通配行折叠：任何 '*' / 'x.*' / 'x:*' 授权都不再被匹配，统一升格为 grants_all
UPDATE public.sys_role r
SET grants_all = true
WHERE EXISTS (
    SELECT 1 FROM public.sys_role_permission rp
    WHERE rp.role_id = r.id AND rp.permission LIKE '%*%'
);

DELETE FROM public.sys_role_permission WHERE permission LIKE '%*%';

-- 3) 部门树：挂公司、自引用父级、物化路径（子树查询走 path 前缀）
--    组织主数据归 IAM 管理，authz 只消费「用户 → 部门子树」窄接口。
CREATE TABLE public.sys_department (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    parent_id uuid,
    code text NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    inserted_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
    updated_at timestamp without time zone DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL
);

ALTER TABLE ONLY public.sys_department
    ADD CONSTRAINT sys_department_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sys_department
    ADD CONSTRAINT sys_department_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.bas_company(id);

ALTER TABLE ONLY public.sys_department
    ADD CONSTRAINT sys_department_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.sys_department(id);

CREATE UNIQUE INDEX sys_department_company_code_index ON public.sys_department USING btree (company_id, code);
CREATE INDEX sys_department_parent_id_index ON public.sys_department USING btree (parent_id);
CREATE INDEX sys_department_path_index ON public.sys_department USING btree (path text_pattern_ops);

COMMENT ON TABLE public.sys_department IS '部门：挂公司的组织树主数据（IAM 维护）；path 为物化路径，子树查询走前缀匹配';
COMMENT ON COLUMN public.sys_department.path IS '物化路径：/{祖先id}/…/{本id}/；移动节点重算整棵子树';

-- 4) 用户单部门（兼任需求出现时再演进为关系表）
ALTER TABLE public.sys_user
    ADD COLUMN department_id uuid;

ALTER TABLE ONLY public.sys_user
    ADD CONSTRAINT sys_user_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.sys_department(id);

CREATE INDEX sys_user_department_id_index ON public.sys_user USING btree (department_id);

COMMENT ON COLUMN public.sys_user.department_id IS '所属部门（至多一个）；部门所在公司必须已在该用户公司授权集内（IAM 写侧硬校验）';

-- +goose Down
ALTER TABLE public.sys_user DROP COLUMN IF EXISTS department_id;
DROP TABLE IF EXISTS public.sys_department;
ALTER TABLE public.sys_role DROP COLUMN IF EXISTS grants_all;
ALTER TABLE public.sys_role_permission DROP COLUMN IF EXISTS scope;
