# 13 — 授权矩阵范围 UI（(role, code, scope) 三元组）

**What to build:** 角色「权限与菜单」抽屉的功能权限页签升级为三元组授权：每个已勾选权限码可设数据范围（全部 / 本部门及以下 / 本部门 / 仅本人），范围选项仅对该资源 `supportedScopes` 命中的维度渲染（目录携带，03 已产出）；无 owner/dept 声明的资源整行不出现范围控件（恒 all）。首版交互从简（如行级统一范围 + 逐码覆盖的两层结构，或每码一个紧凑下拉——实现者按 HeroUI 组件现实取舍，显式决策：表达力优先、UI 后深化）。sync 端点收 `{ permission, scope }[]`；矩阵内核（matrix.ts）随通配取消大幅简化（无 coveredBy 半覆盖态）。

**Blocked by:** 03, 05

**Status:** done

- [x] wire 契约与 sync 端点升级（02 的写侧校验此时全量放开）
- [x] 矩阵组件：范围选择、supportedScopes 驱动渲染、无通配简化
- [x] 角色权限读取回显三元组；审计 diff 含 scope 变化
- [x] 自检用例（permission-sheet-checks）换代
- [x] 产品文档：系统管理篇角色节补数据范围

## Comments
