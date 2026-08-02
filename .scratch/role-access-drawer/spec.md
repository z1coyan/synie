# Spec: 角色「权限与菜单」统一配置抽屉

**Status:** done
**Feature slug:** `role-access-drawer`
**Amends:** [ADR 2026-08-01 角色菜单白名单](../../docs/adr/2026-08-01-role-menu-whitelist.md)（仅配置入口形态，不变量不动）
**Domain terms:** 权限码、权限目录、菜单权限（菜单白名单）、内置角色、超级管理员（见 `CONTEXT.md`）
**Depends on:** `menu-permission`（已交付，main 未推送）

---

## Problem Statement

角色的功能权限（「配置权限」矩阵 Sheet）与菜单白名单（「配置菜单」树 Sheet）分散两个入口。管理员配一个角色要开两个抽屉，且无法直观看到「某个菜单关联哪些权限资源」——两类配置的事实关联（菜单 ↔ 资源）在界面上完全缺失，只能靠管理员脑内翻译（如「员工薪资」菜单 ↔ 工资单/工资发放/员工借款三个资源）。

## Solution

把两处配置合并为角色行内单入口「**权限与菜单**」的统一抽屉：**一个容器、两区强隔离**——抽屉内分「菜单可见性」「功能权限」两个页签（初版为上下两区堆叠，同日按用户反馈改为页签分流，照 SynieRecordDrawer 抽屉内 Tabs 先例；有未保存改动的页签带圆点标记）。菜单页签为原菜单树整体平移（含状态徽标/一键清空/失效项清理），功能权限页签为原权限矩阵整体平移（含搜索/域导航/三态全选）。菜单树每个叶子项旁标注其**关联权限资源**（只读文本，可点击），点击切换到功能权限页签并跳转对应资源行——关联性一眼可见，两类勾选的语义边界不被视觉混同。

**合并只合并容器**：两张表、两个 sync 端点、两套查看/编辑门控、菜单白名单语义（空集=不限制、并集、不拦 URL 直达）全部不动。

## User Stories

1. As a 系统管理员, I want 角色行内单入口「权限与菜单」打开统一抽屉, so that 不用在两个抽屉间切换
2. As a 系统管理员, I want 菜单树每个叶子项旁看到它关联的权限资源名, so that 一眼知道该菜单要配什么权限
3. As a 系统管理员, I want 点击关联资源名跳转到权限矩阵对应行（自动切域、定位、高亮）, so that 不用手动翻找
4. As a 系统管理员, I want 无专属权限的菜单项（工作台/待办等）明确标注「无专属权限」, so that 不用猜它是不是漏配
5. As a 系统管理员, I want 菜单区保留状态徽标「未配置（全部可见）/已限制 N 项」与一键清空, so that 空集=不限制的反直觉语义始终显式
6. As a 系统管理员, I want 两区之间看到「菜单只管导航入口，不拦网址直达」的切割文案, so that 不把菜单勾选当成授权
7. As a 系统管理员, I want 抽屉底部单一保存按钮一次提交两区改动, so that 配完点一下收工
8. As a 系统管理员, I want 一区保存失败时抽屉不关、toast 点名哪区失败、成功区已存、失败区留编辑态可重试, so that 部分失败不丢输入也不糊涂
9. As a 系统管理员, I want 关闭抽屉时任一区有未保存改动则弹确认, so that 误关不丢配置
10. As a 只持「角色菜单」权限的管理员, I want 能打开抽屉配菜单但功能权限区显示「无查看权限」占位, so that 与昨天定的「可分人管理」边界一致、信息可见范围不放宽
11. As a 只持「角色权限」权限的管理员, I want 能打开抽屉配权限但菜单区显示「无查看权限」占位, so that 同上
12. As a 系统管理员, I want 内置角色（admin/sales）抽屉两区均只读, so that 与内置角色只读先例一致
13. As a 系统, I want 菜单 ↔ 资源的关联声明在前端菜单声明上并有契约测试对拍（注解 prefix 须存在于权限目录；目录每个 prefix 须被注解或列入显式「无菜单」白名单）, so that 新资源/新菜单漏注解时 CI 即红

## Implementation Decisions

### 语义规约（grill 六问定案）

- **形态**：一个抽屉、两区以页签强隔离；不做「菜单项下同形嵌套权限勾选」——两类勾选语义相反（权限码全不勾=无权；菜单全不勾=不限制全可见），同形并列会教人错误等式。页签的代价（两区不能同屏）由页签脏点标记 + footer「未保存」清单补偿。
- **映射**：`MenuItem.relatedPermissions: string[]` 显式声明于前端菜单声明（`web/app/lib/menu.ts`），是呈现层导航索引、非模型事实；映射为多对多（1 菜单对多资源：员工薪资→3 资源；资源复用：应收应付→`acc.gl_entry`、库存余额→`inv.stock_entry`；1 菜单对 0 资源：工作台/待办）。
- **保存**：底部单按钮、分区 dirty、顺序提交两个幂等 sync（先菜单后权限）；部分失败处置见 US 8；关闭 dirty 确认见 US 9。
- **门控**：入口 = 任一 read 命中（`sys.role_permission:read` 或 `sys.role_menu:read`）；两区按各自 read 独立渲染（无 read 渲染「无查看权限」占位，不泄露内容）；编辑沿用现规则（权限区 create+delete、菜单区 update）；内置角色两区只读；保存按钮只提交「可编辑且 dirty」的区。
- **入口**：角色行内两个旧操作（配置权限/配置菜单）移除，收敛为单操作「权限与菜单」。
- **命名**：「权限与菜单」——CONTEXT.md 两术语拼合，不发明第三概念，名字即第一道分区。

### 前端结构

- 新组件目录 `web/app/components/synie-role-access-sheet/`：
  - `SynieRoleAccessSheet.tsx`——容器：并行拉取（权限目录+角色授权 | 角色菜单，按门控各取所需）、两区勾选态与 dirty 基线、统一保存编排、跳转编排（切域+清搜索+scrollIntoView+高亮）、关闭 dirty 确认。
  - `menu-section.tsx`——菜单可见性区（自 `SynieMenuSheet` 平移 + 叶子项关联资源注解）。
  - `permission-section.tsx`——功能权限区（自 `SyniePermissionSheet` 平移，矩阵行加锚点 id 与高亮态）。
  - 纯函数层 `access-sheet.ts`——注解展示模型、dirty 计算、保存计划（哪些区需提交）、跳转域推导。
- 旧 `SyniePermissionSheet` / `SynieMenuSheet` 组件删除（入口已收敛，无其他引用）；纯函数层 `matrix.ts`、`menu-tree.ts`、`permission-labels.ts` 原样复用。
- `roles.tsx`：单 rowAction「权限与菜单」（任一 read 门控），传四元门控（两区 read/write）+ builtin。
- 契约测试新增 `web/app/lib/menu-permission-contract.test.ts`：注解 prefix ⊆ 权限目录（自 sealed registry 派生）；权限目录 ⊆ 注解 ∪ 显式「无菜单」白名单（当前白名单为空，fail-closed）。

## Testing Decisions

- **契约测试**（唯一新接缝，对齐 menu-catalog-contract 先例）：上述双向覆盖；`relatedPermissions` 内无重复项。
- **纯函数单测**：dirty 计算（两区独立基线）、保存计划（dirty×可编辑的区才入列）、注解模型（有资源→标签列表；空→「无专属权限」）、跳转域推导（prefix→domain）。
- **存量测试**：`menu-tree.test.ts`、矩阵纯函数测试不动；`menu-catalog-contract.test.ts` 不动。
- 后端零改动（端点/表/门控不动），后端测试不受影响。

## Out of Scope

- 菜单项下同形嵌套权限勾选的树形态（已否定，见语义规约）
- 菜单/权限任一模型、存储、端点、语义的变更
- 「部门管理」死菜单项（`menu.system.depts` 无路由无资源）的去留——另案处理
- 权限矩阵本身的信息架构调整（域分组、动作列不动）

## Further Notes

- 本规格来自 2026-08-02 grill-with-docs 六问定案（形态/映射/保存/门控/入口/命名）。
- 交付时按 AGENTS.md 同步：`docs/产品文档/系统管理.md` 角色权限节、`CONTEXT.md`「菜单权限」词条配置入口句、ADR 2026-08-01 补一句入口合并说明。
- 不立新 ADR：纯呈现层合并、易逆，三判据中「难逆转」不成立；取舍记录于本规格。
