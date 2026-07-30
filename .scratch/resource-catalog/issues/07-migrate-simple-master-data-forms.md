# 07 — 迁移单位、供应商与公司基础表单

**What to build:** 复用币种闭环，将单位、供应商和公司逐个迁移到 Catalog 驱动的 Basic Form，以真实资源补齐 enum、decimal、普通外键、自引用外键和静态 FilterState。客户因附件能力明确留给 Presentation Extension。

**Blocked by:** 06 — 以币种完成首个 Basic Form 闭环.

Status: resolved

- [x] 单位通过 Basic Form 验证 enum、decimal、静态初值和输入策略。
- [x] 供应商通过 Basic Form 验证纯标量 Party 主数据。
- [x] 公司通过 Basic Form 验证币种外键、自引用外键、目标 lookup 和仅启用币种筛选。
- [x] 公司创建默认仓库、币种合法性和层级循环校验仍由领域事务负责。
- [x] 三个资源都删除页面和 drawer 中重复的 label、required、edit、enum、ref 和 exclude。
- [x] 三个页面都只通过各自 ResourceBinding 取得 Reader/Writer。
- [x] renderer 遇到不支持的 JSON 或多态外键布局时 fail-closed，不退化为文本框。
- [x] 无目标读取权的外键不会在 create/edit 中出现可写原始 ID。
- [x] 客户被明确分类为 Presentation Extension，附件面板没有被删除或误算为 Basic Form。
- [x] 每个资源都有 document、binding、create/edit/view 和领域 API 回归测试。
- [x] 每个资源或同形小批次可独立合入并保持仓库全绿。

## Answer

- 服务端 Meta：`basUnits` label=单位 + form basic（enum/span/defaultValue）；`basCompanies` 本币 `filterState`；`purSuppliers` basic；`salCustomers` `form.kind=extension`
- legacy normalizer：initial / span(cols) / filterState / form.kind extension
- 前端：`decodeUnit*|Supplier*|Company*` + `basicFormDrawerProps` 透传 defaultValue/cols/remote
- 页面：units / suppliers / companies 经 `resourceBindingFor` + `useResourceDocument` + catalog 投影
- drawer registry 去掉 basCompanies 静态 filterState 与 purSuppliers 重复条目
- 客户页附件面板保留（未迁移 Basic Form）

## Comments
