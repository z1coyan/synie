# 02 — 角色菜单白名单后端

**What to build:** 让菜单白名单可存、可配、可下发：新建 `sys_role_menu` 表（形态对齐 `sys_role_permission`，`(role_id, menu_code)` 唯一，迁移只建表不写行）；角色新增菜单白名单的读取与整体同步能力——sync 锁定角色行、校验目录内码（目录外 code 拒绝并在报错中点名）、内置角色抛冲突、只增删差量、有变化才写审计（资源 `sys_role_menu`，旧值→新值），删角色同事务清其白名单行；新增权限资源 `sys.role_menu`（中文标签「角色菜单」，仅 read/update 两动作）随权限目录派生进入角色权限矩阵，并门控两个新端点 `GET/PUT /system/roles/:id/menus`；`/auth/me` 响应增挂 `menuCodes`——当前用户所有启用角色白名单的去重并集，超管恒空数组，空数组 = 不限制。交付后用 curl 即可全链路验证：配白名单 → 该角色用户 me 返回并集。

**Blocked by:** 01 — 菜单 code 与前后端目录契约（sync 校验依赖后端菜单目录）

**Status:** ready-for-agent

- [ ] 迁移建 `sys_role_menu`（只建表不写行），老环境升级后角色菜单行为不变
- [ ] `GET /system/roles/:id/menus` 返回白名单；无 `sys.role_menu:read` 被拒
- [ ] `PUT /system/roles/:id/menus` 整体同步；目录外 code 拒绝且报错逐个点名；无 `sys.role_menu:update` 被拒
- [ ] 内置角色 sync 抛冲突（对齐授权只读先例）；同集合同步幂等（无新增审计）
- [ ] 白名单变更写审计（`sys_role_menu`，旧值→新值）；删角色同事务清行
- [ ] `sys.role_menu`（read/update）出现在权限目录与角色权限矩阵中
- [ ] `/auth/me` 返回 `menuCodes`：多角色并集去重、停用角色不参与、全无行=空数组、超管恒空数组
- [ ] PG 集成测试覆盖上述全部行为（对标 IAM 既有集成测试与 auth 测试接缝）
