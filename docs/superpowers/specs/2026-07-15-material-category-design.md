# 物料分类设计

2026-07-15。经拷问访谈定案（决策理由见 `docs/adr/2026-07-15-material-category.md`）。

## 后端

- `SynieCore.Inv.MaterialCategory`，表 `inv_material_category`，新建库存域 `SynieCore.Inv`（权限域 `inv`，物料主档/库存将来同落此域）。
- 全局共享（照单位/币种）：无 `company_id`，集团统一分类学。
- 字段：`code`（手填，全局唯一，trim 非空，不限格式）/ `name` / `is_leaf`（默认 true，注意与科目 `is_group` 语义相反）/ `active`（默认 true）/ `parent_id` 自引用（可空=根，允许多根）。
- `is_leaf` 硬约束：叶子分类不能有子分类；有子分类的不能改成叶子；（将来）物料只能挂叶子分类。
- 编号与上级创建后均可改；将来物料编号生成即固化，不追溯。
- 校验照科目：上级不能是自身；有子分类不能删。
- `children_count` 公开聚合供树形懒加载（照 account：自引用不用 count 聚合，手写）。
- 权限 `inv.material_category`（create read update delete），接审计。
- 接入四处注册缺一不可：SynieCore 域（query/mutations/resources）、GridMeta `@resources` 白名单（漏了报"未知的表格资源"）、permission-labels.ts、logs.tsx。

## 前端

- 独立页 `/scm/material-categories`，菜单「供应链→物料」组下加「物料分类」。
- 照 `/base/accounts`：SynieDataGrid tree 懒加载 + SynieRecordDrawer；无公司选择器。

## 不做（YAGNI）

编号格式约束、层级编号强制父前缀、成环检测（照科目留跟进）、名称唯一、物料挂叶子校验（物料模块落地时加）。
