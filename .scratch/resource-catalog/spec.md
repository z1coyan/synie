# 类型安全 Resource Catalog 深化规格

Status: resolved

## Problem Statement

Synie ERP 已经有服务端 ResourceMeta、Meta Registry 和共享 ResourceMetaDocument，但这条
链路只真正驱动了 Grid。服务端下发的 Form Meta 在前端转换时被丢弃，普通表单仍由页面、
ResourceClient registry、drawer registry 和远程选择器默认配置共同拼装。

从使用者视角看，这会带来几个直接问题：

- 同一字段在列表和表单中可能出现不同标签、必填性、只读性、枚举或外键行为；
- 权限、按钮和实际 API 能力可能不一致；
- 只读资源也会暴露看似可写、实际只会失败的方法；
- 复杂单据和普通主数据共用同一个宽 ResourceClient，无法从类型上判断保存边界；
- 新增或修改资源时必须同时寻找多个 registry 和页面配置，遗漏后往往静默降级；
- 服务端已经拥有的 Form 声明没有减少前端重复维护成本。

问题的本质不是缺少一个新的 Meta 平台，而是现有 Meta 不够深：字段声明、表单布局、
资源能力、transport Adapter 和动态 React 呈现没有清晰的唯一拥有者。

## Solution

将现有 Meta 渐进深化为类型安全 Resource Catalog。Resource Catalog 统一拥有资源与字段
身份、类型、枚举、外键、查询能力、权限动作和基础表单布局，并按当前操作者投影完整
ResourceDocument。Grid 和基础资源表单都消费这份文档。

前端不再用一个宽 ResourceClient 表示所有能力，而是通过单一 ResourceBinding 按需组合：

- ResourceReader：列表和单条读取；
- RecordWriter：只暴露资源实际支持的 create、update、delete 子集；
- AggregateDraftAdapter：完整聚合草稿的读取、创建和整体替换；
- CommandAdapter：带明确 collection、row 或 bulk target 的领域命令。

普通单记录 CRUD 使用 Catalog 驱动的基础资源表单。附件、OCR、子表、动态联动和领域工作流
使用与业务模块共置的 Presentation Extension。Presentation Extension 可以组合基础表单，
但 Resource Catalog 不提供任意脚本、表达式或组件插件机制。

服务端领域模块继续拥有领域校验、事务、审核、库存、总账、受控投影和外部调用。
Resource Catalog 不执行保存，也不会根据 table 和 fields 生成万能 SQL 写入。

迁移采用 expand–migrate–contract：

1. 先保留旧 Grid/Form 投影，在同一 Meta 响应中增加 v2 ResourceDocument；
2. 以币种完成首个端到端基础表单闭环；
3. 按资源能力逐批迁移简单主数据、领域命令、Presentation Extension 和聚合草稿；
4. 所有消费者迁移后删除旧 ResourceClient、drawer registry、remote defaults 和 v1
   兼容投影。

## User Stories

1. 作为 ERP 用户，我希望列表和表单使用同一字段标签，从而避免同一资源在不同界面自相矛盾。
2. 作为 ERP 用户，我希望必填与只读规则在新建和编辑模式保持一致，从而清楚知道哪些内容可以提交。
3. 作为 ERP 用户，我希望筛选器和表单使用相同枚举，从而避免选项在不同视图中丢失。
4. 作为 ERP 用户，我希望外键选择器使用目标资源的规范标签和搜索行为，从而快速找到关联记录。
5. 作为 ERP 用户，我希望无权读取外键目标时该字段不可编辑，从而不会被迫输入不安全的原始 ID。
6. 作为 ERP 用户，我希望按钮反映自己的有效能力，从而看不到无法执行的操作。
7. 作为 ERP 用户，我希望按钮隐藏后服务端仍独立鉴权，从而保证 UI Meta 永远不是安全边界。
8. 作为 ERP 用户，我希望同一标签页切换账号时清除 Actor 相关 Meta，从而不会继承上一位用户的能力或引用可见性。
9. 作为主数据操作员，我希望普通资源使用一致的新建、编辑和查看表单，从而统一日常维护体验。
10. 作为币种维护人员，我希望币种表单保留现有标签和行为，从而让首个迁移保持行为等价。
11. 作为币种维护人员，我希望 ISO code 校验和唯一性继续由服务端执行，从而不因 Meta 迁移削弱领域规则。
12. 作为单位维护人员，我希望枚举、默认值和换算比例输入走基础表单，从而证明 renderer 不只支持字符串。
13. 作为公司维护人员，我希望本币和上级公司选择器遵循 lookup 与固定筛选声明，从而端到端证明外键处理。
14. 作为供应商维护人员，我希望纯标量 Party 主数据使用同一基础表单，从而删除页面重复字段配置。
15. 作为客户维护人员，我希望迁移后附件面板仍然存在，从而不因追求基础表单覆盖率丢失真实能力。
16. 作为发票操作员，我希望 OCR 与动态交互保留专用呈现，从而不被降级成不安全的 Meta 表达式。
17. 作为销售发货操作员，我希望加载和保存覆盖完整草稿聚合，从而不会静默遗漏子记录。
18. 作为销售发货操作员，我希望创建和替换继续使用单一领域事务，从而不会持久化部分草稿。
19. 作为执行行命令的用户，我希望命令在需要时只接受一个记录，从而在 transport 前拒绝非法 target。
20. 作为执行批量命令的用户，我希望命令要求非空记录集合，从而避免空集合伪装成合法操作。
21. 作为执行集合命令的用户，我希望日期范围重算或导入不需要伪造记录 ID，从而让命令契约匹配领域语义。
22. 作为银行业务用户，我希望“对账”使用 reconcile 语义而不是伪装成 export，从而理解命令与权限。
23. 作为考勤用户，我希望“重算”使用 recalc 语义而不是伪装成 import，从而获得可发现、类型安全的命令。
24. 作为前端开发者，我希望每个资源只有一个 ResourceBinding，从而让 Grid、Drawer 和外键预览无法选择不同 client。
25. 作为前端开发者，我希望只读、仅创建和仅更新资源省略不支持的方法，从而不再编写抛错 stub。
26. 作为前端开发者，我希望运行时表单值在单一 codec seam 解码成类型化 API 输入，从而不依赖宽泛断言。
27. 作为前端开发者，我希望未知资源 binding 显式失败，从而让拼写错误无法静默渲染空抽屉。
28. 作为后端开发者，我希望生产与测试共享资源注册入口，从而让测试覆盖真实 Catalog。
29. 作为后端开发者，我希望 Registry 在启动注册后 seal，从而禁止请求期间修改资源定义。
30. 作为后端开发者，我希望跨资源引用和表单字段引用在 seal 时校验，从而让非法 Catalog 在服务流量前失败。
31. 作为后端开发者，我希望 filterbuild 只消费最小读取白名单，从而不依赖完整 ResourceDefinition。
32. 作为后端开发者，我希望 SQL source、join 和默认排序继续由领域查询显式拥有，从而避免 Catalog 变成通用查询引擎。
33. 作为领域开发者，我希望 ResourceDefinition 与服务端鉴权共享类型化权限常量，从而避免权限字符串漂移。
34. 作为领域开发者，我希望校验、审计、过账和外部副作用继续留在领域服务，从而避免 Meta 绕过不变量。
35. 作为测试人员，我希望非法 schema version、字段 kind、布局和 command target 在契约边界被拒绝，从而防止类型断言掩盖 wire 缺陷。
36. 作为测试人员，我希望每个已迁移基础表单和命令都有闭合的 Catalog-to-Adapter 契约，从而让缺失实现阻断 CI。
37. 作为维护者，我希望迁移进度使用明确分母报告，从而量化“已迁移大多数资源”。
38. 作为维护者，我希望所有调用方迁移后删除 legacy registries，从而防止兼容代码成为永久架构。

## Implementation Decisions

- Resource Catalog deepens the existing Meta Registry; it is not a parallel DSL or low-code product.
- ResourceDefinition remains colocated with the owning business module. A single composition-root
  registration function is used by production and tests.
- Registry follows register, seal, project/read lifecycle. Registration after seal fails.
- A temporary legacy normalizer admits existing ResourceMeta definitions into the sealed Catalog.
  New resources cannot use this path, and the normalizer is removed after migration.
- The existing resource Meta response remains backward compatible during expansion. It keeps the old
  name, Grid and legacy Form projection and adds a `catalog` member containing ResourceDocument v2.
- ResourceDocument v2 includes schema version, resource name, independent display label, permission
  prefix, effective capabilities, fields, resource lookup, list layout, form kind and commands.
- Field documents use discriminated kinds for scalar, UUID, JSON, enum, enum array, ordinary reference
  and polymorphic reference fields.
- Field input policy is the single source for create required/optional/forbidden, update
  allowed/forbidden, clearability and static initial value.
- Field value visibility distinguishes readable and write-only fields. Write-only field descriptions
  may appear in forms, but their values never appear in list, read, view or print output.
- Query capability reuses the existing Filter DSL and Sort contract. No second operator vocabulary is
  introduced.
- Target-resource lookup owns canonical label, search, subtitle and default sort fields. An individual
  reference field only adds picker choice, existing FilterState constraints and justified contextual
  overrides.
- Actor projection may mark a reference target unavailable. Grid may show the existing raw-ID fallback,
  but create/edit forms cannot turn that ID into an editable text field.
- Form kind is one of basic, extension or none.
- Basic FormMeta contains only static, serializable layout: sections, tabs, field placement, span,
  placeholder and mode visibility.
- Mode visibility cannot expand field input policy. Update-forbidden fields may be shown disabled but
  are not submitted. Create-required fields must appear in create layout.
- A field can appear only once in a basic layout. Unsupported field kinds make the definition fail
  closed rather than falling back to a text input.
- Presentation Extension owns the complete resource-specific form controller. It may compose the basic
  form internally, but Catalog does not define header, footer, React input, effects or arbitrary slot
  registries.
- ResourceReader owns query and get only. Metadata fetching has a separate lifecycle and cache.
- RecordWriter is a type composition of the actual create, update and delete methods. Unsupported
  operations are absent.
- Basic forms pass runtime values through a binding-specific RecordFormCodec. The codec translates
  transport shape, dates and decimals only; it does not implement domain validation.
- AggregateDraftAdapter distinguishes draft input from saved authoritative draft output and owns
  loadDraft, createDraft and replaceDraft.
- Sales delivery receives a domain-specific complete draft read operation before it becomes the first
  complete AggregateDraftAdapter. Create and replace continue using the existing domain transaction.
- Command contracts declare collection, row, bulk or row-or-bulk target plus typed input and output.
- Standard CRUD contributes capabilities and Reader/Writer methods, not duplicate commands.
- v2 commands use domain-semantic keys such as reconcile, recalc and setDefault. Historical import/export
  aliases remain only in the v1 compatibility projection until contraction.
- ResourceBinding is the only resource-to-Adapter association. A known resource key preserves its Row,
  Query, Create, Update, Draft, SavedDraft and Command types.
- Catalog cache is actor-scoped, or all actor-scoped queries are cleared on session change.
- Dynamic query construction consumes an immutable ResourceReadSpec containing only field names,
  database columns, types, enum values and filter/sort/search capability.
- SQL sources, selects, joins, fixed business predicates, company scope and default ordering remain in
  explicit domain query services.
- The printing-specific catalog is renamed to a narrower printing term and continues deriving fields
  from the sealed Resource Catalog.
- Business modules export typed permission constants used by both ResourceDefinition and server-side
  authorization. Catalog capabilities remain a UI projection, never the authorization boundary.
- Migration follows expand–migrate–contract. No phase may require a broken intermediate commit.
- Currency is the first pilot. Units, suppliers and companies follow. Customer is classified as a
  Presentation Extension because its current form includes attachments.
- Remaining resources are migrated by domain-sized batches. Each resource is explicitly classified as
  basic, extension, none, reference-only or dead/typo before legacy removal.

## Testing Decisions

- Tests assert externally observable contracts and behavior, not source-file strings or internal call
  order.
- The primary seam is the actor-projected resource Meta response through the ResourceBinding consumer.
  During expansion, one response must support both the old Grid consumer and the new Catalog consumer.
- The primary product tracer is the currency page: Catalog definition, actor projection, decoder,
  binding, form codec, Reader/Writer, server validation and UI behavior are tested as one closed path.
- Registry tests cover duplicate resources, invalid fields, invalid enum combinations, broken
  references, invalid lookup fields, repeated layout fields, command/capability mismatch, seal
  immutability and projection closure.
- Shared contract tests cover every field kind, form kind, command target and invalid schema version.
- Query integration tests prove that ResourceReadSpec preserves current filtering, sorting, searching,
  enum validation, polymorphic references and parameterized SQL behavior.
- Frontend contract tests cover actor-scoped Catalog caching, known/unknown binding lookup, read-only and
  partial Writer shapes, form codec conversion and missing Adapter failures.
- Basic form tests cover create, edit and view policy; required fields; disabled update-forbidden fields;
  write-only fields; sections; tabs; defaults; enums; decimals; dates; and ordinary references.
- Permission-matrix tests include a user who can edit the source resource but cannot read a reference
  target. The projected form must not expose an editable raw ID.
- Session tests log in as one actor, clear/switch session, then log in as another actor and verify that
  capabilities and reference visibility are not reused.
- Command contract tests cover setDefault as a row command, attendance recalc as a collection command,
  banking reconcile with its semantic key and a non-empty bulk command.
- Every command test also calls the server endpoint without permission to prove that server-side
  authorization remains effective.
- Sales-delivery tests cover complete draft loading beyond default child-page sizes, atomic create,
  atomic replace, authoritative saved snapshots and rollback on failure.
- Presentation Extension tests prove that customer attachments and invoice OCR remain available and that
  executable React behavior is absent from ResourceDocument JSON.
- Migration reports continuously compare server resources, bound resources, basic writable fields,
  declared commands, Adapter commands, legacy usages and partial/read-only write stubs.
- Contraction cannot start until all report gaps are zero or explicitly classified as catalog-only/none.
- Before each ticket is resolved, shared, server and web type checks, tests and production build run in
  the repository’s established order. Database-backed tests use only the configured test database.

## Out of Scope

- A low-code platform, online form designer, schema marketplace or generic workflow engine.
- Executable expressions, arbitrary scripts, dynamic component paths or React functions in metadata.
- Catalog-driven generic INSERT, UPDATE, DELETE, aggregate save or universal SELECT generation.
- Moving domain validation, transaction handling, audit, approval, voiding, inventory, general ledger,
  controlled projections or external calls into metadata.
- Replacing Hono typed clients with another API technology.
- Converting every complex document into ordinary CRUD.
- Reworking sales-order atomic save as part of the Resource Catalog effort.
- Introducing optimistic locking for sales delivery.
- Changing business rules or user-visible behavior as part of an equivalent migration.

## Further Notes

- Baseline audit at commit `661012f` found 97 server resources, 1,383 fields and 305 actions.
- The frontend had 96 ResourceClient mappings and 84 drawer keys; `mfgSetting` was a stale spelling
  alongside the real `mfgSettings` resource.
- Thirty-six server resources declared Form Meta, but the frontend discarded Form before rendering.
- Twenty-five of those forms contained field hints, eleven contained only exclusions, and none of the
  declared sections or tabs were actually consumed.
- Existing action metadata contains semantic/permission mismatches: setDefault/update is legitimate,
  while banking reconciliation and attendance recalculation were historically disguised as export and
  import.
- The accepted Resource Catalog ADR is the architectural authority for implementation and supersedes the
  earlier Go/OpenAPI Meta shape while preserving its single-authority and fail-closed principles.
- Product documentation is updated only if a migration changes visible fields, labels, defaults,
  attachments, command behavior or business rules. A behaviorally equivalent migration records that no
  product rule changed.
