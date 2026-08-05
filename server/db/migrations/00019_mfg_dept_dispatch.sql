-- +goose Up
-- 部门维度的首个业务消费者（spec .scratch/authz-rewrite §2 试点场景）：
-- 需求单头级「指派部门」（下发车间，业务字段可手填）+ 工单「归属部门」（创建时按创建人部门盖章）。
-- 两列都可空：无部门用户创建的行归属为 NULL，只有 all/self 范围看得见。

ALTER TABLE public.mfg_demand
    ADD COLUMN assigned_dept_id uuid;

ALTER TABLE ONLY public.mfg_demand
    ADD CONSTRAINT mfg_demand_assigned_dept_id_fkey FOREIGN KEY (assigned_dept_id) REFERENCES public.sys_department(id);

CREATE INDEX mfg_demand_assigned_dept_id_index ON public.mfg_demand USING btree (assigned_dept_id);

COMMENT ON COLUMN public.mfg_demand.assigned_dept_id IS '下发车间（指派部门形态）：业务字段，须与需求单同公司；填写不受操作者部门约束，已确认后改派走 dispatch 动作';

ALTER TABLE public.mfg_work_order
    ADD COLUMN owner_dept_id uuid;

ALTER TABLE ONLY public.mfg_work_order
    ADD CONSTRAINT mfg_work_order_owner_dept_id_fkey FOREIGN KEY (owner_dept_id) REFERENCES public.sys_department(id);

CREATE INDEX mfg_work_order_owner_dept_id_index ON public.mfg_work_order USING btree (owner_dept_id);

COMMENT ON COLUMN public.mfg_work_order.owner_dept_id IS '归属部门（盖章形态）：创建时按创建人部门自动写入，不可手填；人调部门不追溯存量行';

-- +goose Down
ALTER TABLE public.mfg_work_order DROP COLUMN IF EXISTS owner_dept_id;
ALTER TABLE public.mfg_demand DROP COLUMN IF EXISTS assigned_dept_id;
