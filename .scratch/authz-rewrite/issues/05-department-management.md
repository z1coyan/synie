# 05 — 部门管理与用户挂部门

**What to build:** IAM 侧组织地基：部门资源（`sys.department`，公司域、树形，对齐物料分类树页先例——DataGrid tree 懒加载）+ 用户表单挂部门（单选，RemoteSelect 限已授权公司的部门）+ 既有菜单占位 `menu.system.depts` 落真页。部门 CRUD 走新权限体系（本资源即可作为 guard/loadAuthorized 的首个消费者之一）。启用/停用独立行动作（对齐 status-toggle 惯例）；停用部门不可再挂用户，存量挂接保留但提示。

**Blocked by:** 02, 04

**Status:** ready-for-agent

- [ ] sys_department ResourceMeta（authz: company + tree）、注册四处接入点、权限码 sys.department
- [ ] 树页（参照科目表/物料分类先例）+ 抽屉表单；path 物化维护（移动节点重算子树）
- [ ] 用户表单加部门字段；IAM 硬校验两条（见 02）在 UI 侧给出明确报错文案
- [ ] 用户列表/详情展示部门列
- [ ] 产品文档：系统管理篇补部门管理节

## Comments
