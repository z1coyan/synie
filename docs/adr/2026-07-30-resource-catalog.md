# ADR：以类型安全 Resource Catalog 收口资源声明与前端能力绑定

2026-07-30，状态：已接受。本 ADR 固化本轮设计边界；实施与迁移由
`.scratch/resource-catalog/` 跟踪。

## 背景

后端已有 `ResourceMeta`、进程内 Registry 和共享 `ResourceMetaDocument`。Registry
会按 Actor 投影 Grid、能力与可见外键，但前端 `gridMeta()` 只保留 `document.grid`，
服务端已经发送的 Form Meta 没有进入实际表单。与此同时，前端分别维护
ResourceClient registry、全局 drawer registry、远程选择器默认表；页面又重复传入
client、字段必填性、可编辑性、枚举与外键配置。

结果不是“缺少 Meta”，而是同一事实存在多个拥有者：字段声明在后端，表单字段策略在
后端和页面各一份，资源到传输客户端的映射在 registry 和页面各一份，抽屉能力又由
另一份全局 registry 决定。宽泛 `ResourceClient` 还要求只读资源伪装 create/update/
delete，并把单记录 CRUD、聚合保存和领域命令压进同一个接口。

## 决策

### 1. 深化现有 Meta 为 Resource Catalog

沿用现有服务端资源定义和 `/meta/resources` 链路，渐进演进为类型安全 Resource
Catalog，不另建 DSL、低代码运行时或第二套资源平台。

Catalog 是以下声明的唯一拥有者：

- 资源与字段身份、wire 类型、标签和输入策略；
- 枚举选项、普通/多态外键及目标资源；
- 可筛选、可排序、可搜索能力；
- 权限前缀、动作与动作所需 capability；
- 列表字段引用和基础表单的静态布局。

权限码由业务模块导出的类型化常量同时供 ResourceDefinition 与 service/route 鉴权使用；
Catalog 投影 UI capability，但不替代服务端每次请求的独立鉴权。

服务端注册完成后显式 `seal()`。seal 阶段完成跨资源引用、字段引用、布局、枚举、动作
及权限声明校验；之后 Registry 不可修改。动态 SQL 只消费 Catalog 派生的、不可变的
`ResourceReadSpec`，不再接收完整 ResourceDefinition。

### 2. ResourceDocument 是唯一前端声明契约

共享契约升级为带 `schemaVersion` 的完整 ResourceDocument。服务端按 Actor 投影可见
字段、外键目标、capabilities 和 commands；Grid 与基础 Form 都从这份文档派生。前端
建立独立 Catalog client/cache，删除 `ResourceClient.meta()` 对 Grid 子集的所有权。

表单使用强类型的字段引用与判别联合。字段是否必填、创建后锁定、只读或可清空属于字段
输入策略，只声明一次；FormMeta 只描述字段摆放、分区/Tab、栅格宽度、占位和 showIn，
不重复 required/edit 等字段事实。外键目标的 label/search/default sort/subtitle 归目标
资源 lookup；引用字段只保留 picker、静态 FilterState 和必要的场景覆盖。

### 3. 按能力拆分前端端口

- `ResourceReader<Row>`：query/get；
- `RecordWriter<Row, Create, Update, CanDelete>`：只暴露资源实际支持的普通单记录
  create/update/delete 子集；
- `AggregateDraftAdapter<Draft, Saved>`：load/createDraft/replaceDraft；
- `CommandAdapter<CommandMap>`：按 collection/row/bulk target 类型化执行审核、作废、
  导入等显式命令。

每个资源通过一个类型安全 `ResourceBinding` 绑定实际 Adapter。只读资源只绑定 Reader；
普通主数据绑定 Reader + RecordWriter；聚合资源绑定 Reader/聚合草稿 Adapter；领域命令
按命令映射绑定。基础 Grid、抽屉、外键预览和复杂页面都从同一 binding 入口取能力，
从而收口 ResourceClient registry、drawer registry 和页面重复 client 选择。

这些是前端到现有 Hono API 的 Adapter，不是写入实现。后端仍由各业务模块实现专用
create/update、`createDraft`、`replaceDraft` 和命令服务。

### 4. 基础表单与呈现扩展分轨

`form.kind = "basic"` 才允许通用表单渲染器消费 FormMeta。动态可见性、跨字段 effects、
React render/input、附件/OCR、子表、整单差异与业务工作流必须放在与页面/业务模块共置
的显式 Presentation Extension。

`form.kind = "extension"` 只声明该资源不适用基础表单；具体扩展由 ResourceBinding
静态导入，不在服务端下发组件名、表达式、函数或脚本。全局 drawer 配置文件不再作为
第二事实源。

### 5. Catalog 永不成为写入引擎

Catalog 和 FormMeta 不得执行或表达：

- 领域校验、状态机和跨聚合不变量；
- 数据库事务、审核、作废、库存、总账和受控投影；
- 外部调用、任意脚本、动态表达式或组件代码；
- 按表名/字段声明自动生成的通用 SQL 保存。

服务端领域模块、事实引擎与现有事务边界保持权威。销售发货现有
`createSalesDraft`/`replaceSalesDraft` 是 AggregateDraftAdapter 写 seam 的首个已证明
先例；完整读取仍须由销售发货领域 API 或经证明完整的 loader 提供。这不是建设通用文档
保存框架的理由。

### 6. 兼容层只派生，不双写

迁移期间现有 Meta endpoint 在旧 `name/grid/form` 旁增加
`catalog: ResourceDocument`。旧前端继续读 `grid`，新 Catalog client 只读 `catalog`；
两者都从同一服务端 ResourceDefinition 投影，禁止手工维护 v1/v2 两份字段、枚举或表单
声明。

旧 Grid action 的 mutation/http 和 destroyMutation 属于临时 transport 兼容事实，无法
也不应从 v2 command 语义反推；它们在对应 CommandAdapter/RecordWriter 落地后删除。
每迁移一个资源就删除其前端静态表单副本，并用契约测试锁定 ResourceDocument 到实际
binding/renderer 的闭环。

## 否决方案

- **另建低代码平台或完整表单 DSL**：扩大安全与维护面，也把局部重复配置升级成新的
  运行时；当前目标只是深化已有 Catalog。
- **Meta 驱动万能 SQL CRUD/聚合保存**：绕过模块事务、审计和领域不变量，无法安全承载
  审核、库存与总账。
- **继续扩充全局 drawer registry**：它混合静态字段事实、React 组件和网络 Adapter，
  只会形成更大的第二事实源。
- **让所有资源实现同一个 ResourceClient**：只读资源会继续携带抛错写方法，聚合更新与
  单记录 PATCH 也无法在类型上区分。
- **把动态条件、effects 或脚本序列化到服务端 Meta**：形成任意代码/表达式执行面，且
  让领域交互难以测试和定位。
- **一次性迁移全部 97 个资源**：缺少真实 renderer 反馈，爆炸半径过大。先以币种等简单
  主数据证明 seam，再按能力分批迁移。

## 后果

- shared、server、web 会在兼容期同时存在 v2 文档和 v1 Grid 投影，但两者来自同一
  ResourceDefinition；旧 action transport 以明确的临时兼容字段隔离并带删除工单。
- Registry 启动会变严格；既有断裂外键、非法布局字段和动作权限错配会从运行时问题变成
  启动失败，需要先做特征测试与清理。
- 前端类型参数和 binding 声明增加少量显式代码，换取只读/CRUD/聚合/命令能力的编译期
  区分以及抽屉配置收口。
- 简单主数据将显著减少页面字段配置；复杂单据仍保留专用页面和领域 Adapter，不以“Meta
  覆盖率”作为目标。
- 打印模块已有同名 `ResourceCatalog` 类型，实施前需改成更窄的
  `PrintResourceCatalog`/`PrintFieldCatalog`，避免共享语言冲突。

## 被取代的旧决策

本 ADR 取代 `2026-07-25-go-fullstack-meta-migration.md` 中关于 Go Meta Registry、
OpenAPI Resource Client 和“前端 registry 作为 Form 过渡权威源”的技术形状。旧 ADR
关于单一元数据权威源、未知资源 fail-closed、不过度复刻 Ash DSL 的原则继续有效；当前
后端技术栈以 Bun/TS/Hono 的既成迁移结果为准。
