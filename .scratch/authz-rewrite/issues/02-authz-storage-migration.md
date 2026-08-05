# 02 — 授权存储迁移与通配取消

**What to build:** 授权数据层换代：`sys_role_permission` 加 `scope`（`all/dept_tree/dept/self`，默认 all；`granted` 值写侧拒绝）；`sys_role` 加 `grants_all`；新建 `sys_department`（挂公司、物化路径、`(company_id, code)` 唯一）；`sys_user` 加 `department_id` 可空列。种子改造：内置 admin 的 `*` 授权行改 `grants_all=true`；`sales` 角色逐码行补 scope=all。Actor 装配迁入 `platform/authz`（吸收 `auth/store.ts:actorByUserId`），加 30s TTL 缓存，装配部门子树。通配全面取消：删服务端 `candidates()`，`syncRolePermissions` 保留目录闭包并新增 scope 合法性校验（资源不支持的维度拒授）；`/auth/me` 返回形状随 Actor v2 调整（grantsAll + 精确码 + 部门）。

**Blocked by:** 01

**Status:** ready-for-human

- [x] 迁移：sys_role_permission.scope / sys_role.grants_all / sys_department / sys_user.department_id
- [x] 种子与 `db/seed-admin.ts`、setup `seedBuiltinRoles` 改造（无 `*` 行）
- [x] Actor 装配（含 grants_all 展开、部门子树物化、30s TTL）迁入 platform/authz
- [x] IAM 写侧硬校验：设用户部门须持该公司授权；回收公司授权遇部门冲突拦截提示
- [x] syncRolePermissions：目录闭包（改用 registry.allPermissionCodes）
- [ ] scope 合法性校验 —— all-only 已落地（写侧恒 `scope: 'all'`）；wire 携带 scope 后开闸，随工单 13
- [x] /auth/me 形状升级，web 侧编译通过（行为收口在 14）
- [x] 服务端 candidates() 删除，授权相关集成测试全绿

## Comments

2026-08-05 实施：迁移 `00018_authz_scope_and_department.sql`（含存量通配行折叠为 grants_all 并删行）；
Actor 装配在 `platform/authz/{store,build-actor}.ts`（30s TTL，测试基座 ttlMs=0）；
`platform/authz/actor.ts` 降级为扫荡期过渡层（旧原语在 Actor v2 之上重写，全部 @deprecated）；
`platform/authz/testing.ts` 提供 testActor（兼收旧字段），存量测试机械换代。
IAM 硬校验落在 `assertDepartmentWithinCompanies`（create/update 双向覆盖）；
部门字段的 wire/UI 暴露随工单 05。
