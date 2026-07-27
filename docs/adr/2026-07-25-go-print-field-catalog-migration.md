# ADR：Go 打印字段目录迁移采用兼容快照与稳定接口

- 状态：已完成（快照机制被 meta.Registry 派生取代，2026-07-27）
- 日期：2026-07-25

## 背景

旧打印字段目录由 Ash 资源反射即时派生。Go 迁移按资源分批进行，当前 Go Meta Registry
只包含已迁移资源；若打印模块直接改为只读取 Go Registry，会立即把尚未迁移但仍可打印的
权限资源从模板管理页删除，破坏现有模板契约。

旧目录的公开面同时包含头字段、一层单数关联、Party 路径、has_many 循环区及循环目标的
嵌套循环判定信息。仅保存页面展示 JSON 不足以保持上传校验，因为页面 JSON 不公开循环目标
自身有哪些 has_many。

## 决策

打印模块对外只提供三个稳定操作：

1. 列出可打印资源；
2. 取得某资源的头字段与循环区；
3. 校验从 xlsx 提取出的占位符集合。

迁移期由旧 Elixir/Ash 权威运行时机械捕获完整目录，作为 Go 内嵌兼容快照。快照包含公开
字段面，以及仅供校验使用、不从 REST 返回的 `nestedLoops`。基线为 60 个权限资源、
1,223 个头字段、28 个循环区、1,060 个循环字段。

模板服务、HTTP 和前端只依赖上述接口，不依赖快照文件格式或 Ash。以后所有相关 Go 资源
具备足够的关系 Meta 后，可以在模块内部改为 Go Meta 派生并用同一快照做回归对拍，无需
改调用方或 API。

## 结果

- 分批迁移期间不缩窄打印资源面，也不需要把请求代理回旧后端。
- 上传校验保持旧版的错误分类和中文文案，包括未知头字段、未知循环字段、二层关联和嵌套
  循环。
- 快照是迁移兼容基线，不是新的业务配置表；业务术语与规则仍由 `CONTEXT.md` 和产品文档
  定义。

## 后续（2026-07-27，工单 #12）

Go Meta 关系信息已完备，快照按既定计划被 meta.Registry 派生取代：

- 目录资源 = 权限前缀的打印头资源（`ResourceMeta.PrintHead` 显式标记；前缀下只有一个
  非投影候选时自动认定；`ReadPermissionsAny` 投影视图不参与）。
- 字段面 = 资源标量与计算/投影字段（剔除 `id`/时间戳/敏感字段/`*_id` 外键列）
  + belongs_to 一层展开（`relation.目标标量`，目标侧跳过 `FieldMeta.Calculated`）
  + 封闭枚举多态的 `relation.labelField`（`party.name`）；开放字符串多态（voucher）
  不展开；子表多态外键经 `FieldMeta.PrintRawID` 只暴露原始 `party_id` 列。
- 循环区 = 头资源 `ResourceMeta.PrintLoops` 声明，嵌套循环取循环目标自身的
  `PrintLoops`，复用资源间既有关联表达，没有第三套关系描述。
- 仅打印可见的历史遗留字段（`has_children` ×3、`accBillHoldings.label`）以
  `FieldMeta.PrintOnly` 留在 meta 字段列表，不进 Grid 文档；`sysRolePermissions.role_id`
  补上了缺失的 `sysRoles` Ref。
- 删除前对拍：派生目录与快照逐资源逐字段（含循环区与 `nestedLoops`）完全一致，
  60/60 资源零差异；随后快照与过渡测试一并删除，结构断言由
  `printing/catalog_registry_test.go` 接替。
