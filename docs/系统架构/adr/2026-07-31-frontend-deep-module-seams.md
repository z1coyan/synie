# ADR：以深模块收口前端资源调用、聚合草稿与呈现扩展

2026-07-31，状态：已实施。本 ADR 是
[`2026-07-30-resource-catalog.md`](./2026-07-30-resource-catalog.md) 的后续深化，
不改变 Resource Catalog 不执行领域写入的既有取舍。

## 背景

Resource Catalog contract 完成后，前端已经有 ResourceBinding、按能力拆分的 Adapter、
AggregateDraftAdapter 与 Presentation Extension，但 implementation 仍有五类知识泄漏：

- Grid 查询键实际包含 transport id，页面却自行拼接 `gridRows` / `rowById` 失效键；
- 页面重复向 Grid 与 Drawer 传具体 client，使 ResourceBinding 没有成为唯一解析 seam；
- 复杂单据 Drawer 自行循环保存表头、明细与阶梯，失败可能留下部分可见状态；
- 21 项 Drawer 配置和 8 项文档速览集中在两个全局 registry，业务变更缺少 locality；
- Hono response 类型在 `Promise<Response>` interface 处提前丢失，资源 Adapter 重复解析、
  query body 与 wire codec；迁移期测试又大量读取源码并断言 import、prop 和配置数量。

这些 module 大多是浅的：调用者仍需知道 implementation 身份、缓存结构、保存顺序和文件
形状。删除任一薄层后，复杂度不会消失，只会重新散落到页面。

## 决策

### 1. ResourceBinding 拥有 Reader 对应的缓存身份

每个 ResourceBinding 除 Reader/Writer/Draft/Commands 外，同时拥有该 Reader 对应的列表与
单条缓存身份、查询键 factory 和精确失效动作。`SynieDataGrid`、
`SynieRecordDrawer` 与业务页面只表达资源内查询维度或“失效此资源”意图，不知道
transport id，也不手写 TanStack Query key。

生产 Hono Adapter 与测试用 in-memory Adapter 通过同一 ResourceBinding interface。
生产资源入口持有并恢复模块装配时创建的规范 binding，同名测试替身不能污染生产解析。
生产页面不再向 Grid、Drawer、EditableTable 或远程选择器传具体 client；DataGrid 与远程
source 仅保留显式 custom/in-memory Adapter seam，供局部读模型与 interface 测试使用。

领域命令在对应 `CommandSpec` 旁声明成功后受影响的资源；统一失效 module 自动包含命令
所属资源和系统审计日志、去重，并在执行 handler 前解析全部 binding；配置错误不产生
领域写入。row、bulk、rowOrBulk 与 collection 命令以及列表审核和「保存并审核」都穿过
同一命令及失效 interface，不由调用者重复维护依赖，也不遍历全 registry 清空无关资源。

### 2. 完整单据只经业务 Aggregate Draft seam 保存

表头与子条目共同构成业务聚合时，前端通过该业务 module 的
`AggregateDraftAdapter<Draft, Saved>` 执行 load/create/replace。生产 Adapter 一次请求
跨越 seam，后端领域 module 在单一数据库事务内保存完整草稿并校验所有权与领域不变量。
测试使用 in-memory Adapter，并在数据库可用时验证中途失败整单回滚。

完整替换的 wire contract 必须显式提交全部集合与嵌套子树，缺字段按 validation
fail-closed，不能用默认空数组把协议错误解释为删除全部。多次 SELECT 组成的
`loadDraft` 使用 repeatable-read 一致快照，避免把不同提交代际拼成一个可再次保存的
草稿。从旧逐子资源写入迁移的聚合继续保留 create/update/delete 独立授权：replace
根据实际新增、更新、删除差异追加校验，不因收口 transaction 扩大权限。

客户端顺序执行 head/item/tier create/update/delete 即使藏进 helper，也不等价于原子
保存。Resource Catalog 不解释草稿，不生成通用 SQL，不成为万能单据写入引擎；每类
聚合仍拥有自己的 Draft/Saved 类型与后端 transaction。

### 3. Presentation Extension 与业务 module 共置

Drawer 字段策略、动态 React、审核呈现与 document preview 归对应业务 Presentation
module 所有。全局 registry 只把资源键装配到业务 factory，并继续对未知资源
fail-closed；Resource Catalog 只保留可序列化的静态资源事实。

文档速览子表只声明资源键、父单筛选语义或最小 Reader loader；运行时统一从该资源的
ResourceBinding 取得 Reader 与缓存身份。特殊跨两段查询的业务 loader 也只接受 Reader
resolver，不保存生产 client。

这显式重访 Resource Catalog contract 后“保留 21 项集中配置”的实施形态：21 个资源
分母不变，但配置 implementation 不再留在全局 registry。不存在的 audit/preview 能力
保持缺席，不为统一对象形状虚构 interface。

### 4. Hono transport 保留 response 类型并集中 wire codec

Hono transport module 从 `ClientResponse<Body, Status, Format>` 推导成功 response body，
只把运行时解析所需的最小 response interface 暴露给 implementation。真实 Hono response
与测试 fake 穿过同一 seam。

错误 response 继续解析项目 `ApiErrorBody` 并构造 `APIError`，保留 code、message、
fields 与 status；不改用 Hono `DetailedError`。通用 query/list body 与日期、金额等 wire
codec 收进同一深 module，各资源 module 仍拥有业务 Row/Input 类型，且不引入 GraphQL、
OpenAPI codegen 或第二条请求路径。

### 5. 测试穿过 module interface

ResourceBinding、Presentation Extension、Aggregate Draft 与 transport 的测试断言
interface 上的可观察结果，并使用 in-memory/fake Adapter。读取 `.tsx` 源码并约束 import、
prop、registry 数量或引号格式的迁移期测试删除。

确需静态验证的“禁止旧 GraphQL/openapi 路径”和依赖方向集中为一个架构守卫；该守卫只
检查架构规则，不承担业务行为测试。

## 否决方案

- **继续手写完整查询键**：调用者必须知道 transport identity，ResourceBinding 没有产生
  leverage，且前缀遗漏会留下陈旧数据。
- **所有写入后全局失效**：虽然能掩盖错误 key，但把依赖关系变成隐式全局状态，并增加
  无关请求。
- **建立通用前端文档保存器**：只把循环从 Drawer 移到另一个浅 module，无法提供数据库
  原子性，也会把不同聚合的不变量混在一起。
- **继续扩大全局 Presentation registry**：业务 JSX、预览与 Drawer 规则失去 locality，
  registry 再次成为第二事实源。
- **用更大的泛型断言修复 Hono 类型**：把不确定性藏进 transport interface，调用者仍
  得不到静态 leverage。
- **继续维护源码正则契约测试**：implementation 重排会导致无业务回归的失败，并阻止深
  module 重构。

## 后果

- 页面通过资源键取得 Reader、缓存身份和失效动作；复杂业务跨资源影响与领域命令共置，
  两条审核入口共享同一精确失效实现。
- 已迁移聚合的保存失败不会留下表头或部分子条目；新增聚合须先证明后端单事务 seam。
- 聚合读取返回同一提交代际；replace 的缺失集合不会被静默当作空集合，且迁移前的子树
  写权限语义保持不变。
- Presentation registry 变薄，修改某业务资源的 Drawer/preview 时只需进入对应业务
  module；preview 查询会被对应 binding 的列表失效准确命中。
- transport 类型与 codec 的修复集中生效；兼容调用点必须有明确清单并逐步删除。
- interface 测试能够在 implementation 重排后继续提供安全网；架构守卫与业务测试职责
  分离。

## 实施记录

- 六个聚合头资源 `purOrders`、`purQuotations`、`purReceipts`、`salDeliveries`、
  `salOrders`、`salQuotations` 已只通过 Aggregate Draft 创建/替换，普通 writer 只保留
  删除；后端 create/replace 均为单事务，完整替换 schema 对全部子集合 fail-closed；
  编辑态在权威子树完整加载前禁用并拒绝提交，暂态空集合不会被解释为删除全部子记录。
- 21 项 Drawer Presentation 与 8 项文档速览已迁入业务模块，全局 registry 只保留装配；
  preview 通过 binding Reader 与 cache scope 读取。
- 生产资源 Adapter 已统一使用类型化 Hono response 与共享 wire codec；动态 Catalog
  表单的 request body 仍保留边界处可见的 `as never`，这是后续逐资源收窄请求类型的已知
  债务，不影响本次 response 类型、运行时校验与聚合草稿完整快照契约。
- 旧路由源码形状测试已由 interface 行为测试和一个集中架构守卫替代。
