# Batch 2 验收记录

验收起始日期：2026-07-25。本文持续追加第 2 批资源；截至 2026-07-26 已关闭
PR-2.1 至 PR-2.13。

## PR-2.1 用户、角色与权限矩阵

- Go IAM 模块拥有用户/角色 CRUD、随机一次性密码、argon2id、密码重置、角色/公司授权、
  权限目录与角色权限同步；内置角色不可改、删或改授权。
- 权限同步只管理 Registry 中的具体权限码，保留存量通配码与目录外码；未知具体码拒绝。
- OpenAPI 与前端 `userClient` / `roleClient` 已接通；用户页、角色页和权限矩阵不再发
  业务 GraphQL。
- Meta 契约测试钉住 Elixir 公开字段面、能力裁剪、表单排除和密码敏感字段。
- 真实 PostgreSQL 冒烟覆盖角色创建/授权、用户创建/登录/授权清空、密码重置、删除；
  受限 Actor 只有 `base.company:read` 时创建公司返回 403，空公司范围 fail-closed。
- Chromium `iam.go.e2e.ts` 覆盖角色 Grid/Drawer 创建、检索和 REST 清理，GraphQL 请求为 0。

## PR-2.2 公司与用户公司范围

- 公司 Meta、FilterState 查询、CRUD、审计、本币启用校验、编号唯一约束均由 Go 拥有。
- 公司树校验覆盖任意深度：上级不能是自身或自己的下级，存量循环也拒绝继续挂接。
- 创建公司与三座默认仓库在同一 PostgreSQL 事务完成；公司或任一仓库/审计写入失败时
  整体回滚，不再由前端二次 GraphQL 编排。
- `basCompanies` GridMeta 与迁移前真实 Elixir 快照做 JSON 语义对拍。
- 用户公司授权选择器显式使用 `companyClient`；公司抽屉的上级公司与启用本币选择器也
  显式使用 REST client 和结构化 FilterState。
- 真实 PostgreSQL 冒烟覆盖两级公司、任意深度成环 400、每公司三仓、查询、审计及引用
  删除 409；测试数据已精确清理。
- Chromium `company.go.e2e.ts` 覆盖公司页、启用本币、上级公司和用户公司授权选择器，
  GraphQL 请求为 0。

## PR-2.3 计量单位

- Go 单位模块拥有查询与 CRUD，单位类型限定长度/面积/重量/数量，换算比例必须大于 0，
  基准单位比例恒为 1 且每类型至多一个；符号全局唯一，已被业务数据引用时删除返回冲突。
- OpenAPI 与前端 `unitClient` 已接通；单位 Grid/Drawer 不再发业务 GraphQL。
- `basUnits` Meta 快照由迁移前 Elixir `GridMeta.resolve/2` 真实捕获，契约测试钉住字段、
  枚举、能力、表单排除和删除动作；另有受限 Actor 创建返回 403 的 HTTP 契约。
- 真实 PostgreSQL 冒烟覆盖创建、查询、更新、删除、字段级审计、基准单位唯一冲突及
  行情品种引用后的删除冲突；测试数据精确清理。
- Chromium `unit.go.e2e.ts` 覆盖单位页 Grid/Drawer 创建、检索和 REST 清理，
  GraphQL 请求为 0。
- 修复迁移镜像内 goose baseline 对运行用户不可读的问题，`docker compose run --rm migrate`
  已在空库成功执行。

## PR-2.4 会计科目树

- Go Account 模块拥有公司范围查询、CRUD、任意深度防环、同公司父节点校验、`hasChildren`、
  字段级审计、引用/有子节点删除冲突与不可变公司归属；树写入以公司级事务锁串行化。
- 12 个科目角色及借贷方向由静态 Meta/OpenAPI 枚举约束；角色仅允许叶子科目，转汇总自动
  清空，外币角色拒绝，人民币或未设币种可挂。
- CAS/SMALL/INTL 权威模板由旧 `AccountTemplates` 机械导出为 Go 内嵌静态数据，分别固定
  97/70/40 条；空公司校验、父先子后、逐条审计和全部写入同一事务，并发初始化实测恰好
  一次成功。
- `basAccounts` GridMeta 与迁移前真实 Elixir 快照做 JSON 语义对拍；OpenAPI、sqlc 查询、
  HTTP 权限、前端 `accountClient` 和结构化 FK `isNil` 树根筛选已接通。
- Account 页面公司选择、模板初始化、树展开、Grid/Drawer 创建与编辑、启停动作均走 REST；
  静态扫描与 Chromium `account.go.e2e.ts` 均确认 GraphQL 请求为 0。
- 真实 PostgreSQL 测试覆盖公司隔离、跨公司父节点、任意深度成环、角色/币种规则、模板条数
  与预设角色、并发串行化、审计及父节点删除冲突；修正测试连接池清理顺序后，夹具公司前后
  计数不增长。

## PR-2.5 文件、附件与存储接入

- Go Files 模块拥有不可变文件、业务挂接与存储接入 CRUD；上传限制 50MB，生成日期/UUID/安全扩展名对象键并计算 SHA-256。
- 对象先写、文件元数据/可选挂接/审计同一 PostgreSQL 事务提交；失败补偿对象。删除先提交元数据与审计，再限时尽力清理对象，与旧 Ash after_transaction 契约一致。
- 附件宿主注册表显式白名单且未知类型 fail-closed；列表、删除和下载同时校验 sys.file 权限、宿主读权限与公司范围，裸文件仅上传者或超级管理员下载。
- 存储接入支持 local、S3 与 OSS，默认点以事务 advisory lock 串行切换；接入名和类型不可变，密钥只写不回读，内置/默认/仍存文件的接入点不可删。
- sysFiles 与 sysStorages Meta 均与迁移前真实 Elixir 快照语义对拍；Attachment 原实现无独立 Grid Meta 且共享 sys.file 权限，其 OpenAPI、宿主注册表、审计和公司域行为由专项契约钉住。
- OpenAPI、sqlc 查询、Go HTTP、前端 fileClient/storageClient、附件面板及 FK 预览 REST 注册表已接通；Files 页面与共享附件组件不再发业务 GraphQL。
- 真实 PostgreSQL 测试覆盖上传/下载/挂接/删除保护、失败回滚、公司隔离、密钥脱敏、并发默认切换和精确清理；S3 适配器测试覆盖前缀与预签名 URL。
- Chromium files.go.e2e.ts 覆盖存储 Grid/Drawer、设默认、multipart 上传、文件详情、挂接展示与下载，GraphQL 请求为 0；全量 Go 浏览器回归 6/6 通过。

## PR-2.6 编号规则与计数器

- Go Numbering 模块拥有规则 CRUD、计数器查询/手工调整与自动取号；规则绑定资源创建后
  不可改，每资源至多一条启用规则，删除规则由 PostgreSQL 外键级联删除计数器。
- 固定文本、直接/一层关系字段、日期格式和恰好一个序号段由服务端白名单校验；
  `padding=0` 不补零，字段空值省略，按公司时公司编码进入 scope key。
- 25 个可编号资源与 695 个可选字段从迁移前真实 Elixir/Ash 反射机械捕获为 Go 内嵌目录；
  REST 只公开路径、标签和类型，不公开表名/列名，动态查询标识符在加载时 fail-fast 校验。
- 原子计数由 sqlc `IncrementNumberingCounter` 的 PostgreSQL upsert 完成；20 路并发取号完整
  产生 `01..20` 且无重复，并发创建启用规则实测恰好一次成功、另一次返回 conflict。
- 规则创建/更新/删除与计数器手工调整写字段级审计；自动取号不写审计且允许保存失败产生
  序号空洞。真实 REST 验收覆盖 Meta、目录、规则 CRUD、计数器筛选/调整、级联与审计。
- `sysNumberingRules` / `sysNumberingCounters` GridMeta 均与迁移前真实 Elixir 快照语义对拍；
  Counter 与 Rule 共享 `sys.numbering_rule` 权限前缀，Registry 按前缀聚合动作而不重复目录。
- OpenAPI、Go HTTP、sqlc、前端双 ResourceClient、SynieDataGrid、SynieRecordDrawer 与嵌套
  SynieEditableTable 已接通；字段组装器直接消费 REST 字段目录，不再反查未迁移资源的
  GraphQL Meta。
- Chromium `numbering.go.e2e.ts` 覆盖规则创建、计数器编辑与启停，目标页面 GraphQL 请求
  为 0；全部 Go 浏览器竖切回归 7/7 通过。完整 Go、前端类型、纯函数、单测与构建门禁通过。


## PR-2.7 打印模板与字段目录

- Go Printing 模块拥有打印模板查询、CRUD、设为/取消默认与业务侧可用模板列表；模板全局
  共享、不套公司范围，资源创建后不可改，同资源默认切换由 PostgreSQL advisory lock
  串行化，并发设置后仍恰好一份默认。
- 60 个权限资源、1,223 个头字段、28 个循环区与 1,060 个循环字段从迁移前真实
  Elixir/Ash 反射机械捕获；内部额外保存循环目标的 `nestedLoops`，REST 只公开旧版
  `resource/fields/loops` 形状。目录边界与后续 Go Meta 派生取舍记录于 ADR。
- Go xlsx 解析器只读取首个工作表，支持共享字符串、富文本和 inline string；上传校验保持
  未知头字段、未知循环字段、二层关联、嵌套循环及未知资源的旧版分类和中文错误文案。
- 模板创建/换文件在同一事务同步唯一 `sys_print_template` 附件；删除模板清附件但保留不可变
  文件本体。CRUD、设默认、取消默认以及被默认切换连带取消的记录均写字段级审计。
- 字段目录与业务模板列表允许 `资源:print/export/batch_print` 或
  `sys.print_template:read` 任一权限；管理 CRUD 仍分别校验模板权限。HTTP 契约证明权限
  在 JSON 解码前拒绝，模板无公司维度。
- `sysPrintTemplates` GridMeta 与迁移前真实 Elixir 快照语义对拍；OpenAPI、sqlc 附件
  查询、Go HTTP、`printTemplateClient`、SynieDataGrid 与 SynieRecordDrawer 已接通。
  共享打印弹窗的模板列表/字段目录也改走 Go REST；PDF/xlsx Renderer 按既定 3.x 批次迁移。
- 真实 PostgreSQL 测试覆盖无效扩展名/占位符、搜索、仅业务打印权限读取、并发默认切换、
  换文件、附件、审计、删除后文件保留和精确清理。REST 验收确认 60/1,223/28/1,060
  目录基线；Chromium `printing.go.e2e.ts` 覆盖上传、创建、设默认和编辑，目标页面
  GraphQL 请求为 0；全部 Go 浏览器竖切回归 8/8 通过。

## PR-2.8 Settings（已关闭）

2026-07-26 完成最终验收；`sal_setting`、`mfg_setting`、`acc_setting`、`sys_setting` 四个
资源一并关闭，严格进度更新为 **19/100**。

- `sal_setting`、`mfg_setting`、`acc_setting`、`sys_setting` 均按全局单行资源实现
  GET/PATCH，不开放 list/create/delete；Meta 仅声明 read/update，四份 GridMeta 与迁移前
  Elixir 捕获快照逐 JSON 对拍。
- sqlc 查询、行锁更新、服务层校验与字段级审计已接通：数量上限必须大于 0，四项容差均为
  0～1，行情最新价间隔只允许 30/60/120 分钟；行情运行摘要最多保留 500 个字符。
- 财务 OCR Secret 只写不回读：响应 DTO 与 Meta 均不含 Secret，省略或传空字符串保留旧值；
  Secret 变更的审计 from/to 均固定为 `[FILTERED]`。专项 PostgreSQL 测试与 REST 验收脚本
  还检查响应、Meta、审计均不出现 Secret 原值。
- OpenAPI 与前端四个 singleton ResourceClient 已注册；供应链设置三个 Tab、财务设置、基础
  设置·行情拉取、行情页状态摘要、销售/采购订单抽屉的设置读取均已改用 Go REST。
- HTTP 契约测试覆盖四类 PATCH 在 JSON 解码前先做 update 权限拒绝；
  `.scratch/migration/verify-settings-rest.ts` 覆盖四份 Meta、四类 GET/PATCH、非法间隔、
  四类审计与 Secret 过滤；`settings.go.e2e.ts` 覆盖五个设置入口保存且 Settings GraphQL=0。
- 既有产品文档已覆盖供应链/生产/财务/系统设置的用户可见规则，`CONTEXT.md` 已定义对应
  领域术语及 Secret 只写不回读契约；迁移不改变业务语义，无需制造“已迁移”类领域术语。

最终运行证据：

- [x] 空 PostgreSQL 卷执行 `docker compose run --rm migrate` 成功，goose baseline/增量完整落库。
- [x] `SYNIE_TEST_DATABASE_URL=... go test ./...` 在真实 PostgreSQL 全量通过，Settings 专项
  PostgreSQL 测试未 skip；同一全量 Go 测试在容器环境通过。
- [x] 在 `web/` 依次执行 `bun run openapi`、`bun run typecheck`、`bun test`、
  `bun run build`，全部通过。
- [x] 在仓库根目录设置 `GO_API_URL=http://127.0.0.1:8080/api/v1` 与
  `SYNIE_TEST_DATABASE_URL=...` 后执行 `bun .scratch/migration/verify-settings-rest.ts`，输出
  `settings REST acceptance ok: meta=4 API=4 ... secret=[FILTERED]`；以该次唯一 Secret 哨兵
  复扫服务日志，API、Meta、审计与日志均不含 Secret 原值，审计只出现 `[FILTERED]`。
- [x] 在 `web/` 执行
  `E2E_BASE_URL=http://127.0.0.1:3011 bun run e2e:go -- settings.go.e2e.ts`，Chromium 1/1
  通过；再执行 `E2E_BASE_URL=http://127.0.0.1:3011 bun run e2e:go`，全量 Go Chromium 9/9
  通过。
- [x] 静态复扫 Settings 页面、行情页状态摘要及销售/采购订单抽屉，
  `salSetting` / `mfgSetting` / `accSetting` / `sysSetting` 业务 GraphQL 查询为 0。

## PR-2.9 行情品种与行情价点（已完成）

本 PR 已完成 `bas_market_instrument` 与 `bas_market_price_point` 两个资源。迁移保持行情品种、
不可变价点、走势图与无外网刷新边界的既有业务语义；严格进度由 **19/100** 更新为
**21/100**。

完成 DoD：

- [x] 从迁移前 Elixir 捕获 `basMarketInstruments` / `basMarketPricePoints` GridMeta 快照，
  钉住字段、枚举、表单排除、能力与扩展动作。
- [x] 实现 sqlc、Go service/HTTP、OpenAPI 与两个 ResourceClient；权限拒绝发生在解码/写入前，
  CRUD、作废、刷新均写字段级审计。
- [x] 行情品种契约覆盖编码唯一、必填口径、启停、拉取映射、已有价点时删除冲突；行情价点
  覆盖价格大于 0、有效键唯一、不可编辑、只作废不物理删除。
- [x] 迁移 `chart_instruments`、`price_series`、`refresh` 与 `void` 非 CRUD 表面，保持图表多品种、
  价类/时间窗、作废点排除及刷新后记录系统设置运行摘要的既有行为。
- [x] `base/market.tsx` 的品种/价点 Grid、抽屉、图表、补录、作废与刷新全部改走 REST；已完成
  的系统设置 REST 不回退，目标页面业务 GraphQL 请求为 0。
- [x] 补真实 PostgreSQL、权限/Meta/REST 验收与 Chromium 行情 E2E，并重跑空库迁移、Go 全量、
  OpenAPI、typecheck、前端测试、build 和全部 Go Chromium 回归。
- [x] 复核 `docs/产品文档/行情管理.md` 与 `CONTEXT.md`；本次未改变业务规则或术语，无需改动。
- [x] 两个资源改为“已完成”，严格进度更新为 **21/100**。

验收证据：

- `.scratch/migration/capture_market_contract.exs` 生成迁移前快照
  `snapshots/pr-2.9/basMarketInstruments.grid.json` 与
  `snapshots/pr-2.9/basMarketPricePoints.grid.json`；Go Meta 逐字段语义比对通过，价点 `void`
  同时出现在 capability 与扩展动作。
- 空库按 `00001` / `00002` / `00003` 迁移成功；四条行情种子重复执行不增量，并验证回滚再升级
  不覆盖已有 `fetch_enabled`、最近抓取状态及自定义外部映射。
- 设置真实 `SYNIE_TEST_DATABASE_URL` 后执行 `go test ./...` 全量通过；行情生命周期、序列、刷新、
  权限先拒绝及审计使用真实 PostgreSQL。单位引用删除夹具的 teardown 顺序已修正，并以同一测试
  连跑两次确认 `REF-*` 残留为 0。
- `bun .scratch/migration/verify-market-rest.ts` 输出
  `market REST acceptance ok: meta=2 instruments=5 points=4 chart=3 series=2 refresh=3 audits=17`；
  覆盖 Meta、CRUD、必填/唯一/价格大于 0、不可变、作废重录、删除冲突、chart/series 边界、
  无公网 refresh、运行摘要与审计，脚本结束后专用记录及审计归零。
- 行情前端契约测试确认两个 Grid、两个 Drawer 与共享外键选择器均显式解析 REST client；
  `market.tsx` 的业务 `gqlFetch` / `/graphql` 静态复扫为 0。
- `bun run openapi`、`bun run typecheck`、`bun test`（34/34）、`bun run check` 与 `bun run build`
  全部通过；build 仅保留既有大 chunk 警告。
- `E2E_BASE_URL=http://127.0.0.1:3011 bun run e2e:go -- market.go.e2e.ts` 定向 1/1 通过；全量
  `bun run e2e:go` 10/10 通过。行情用例真实覆盖 Grid、Drawer 创建/编辑/删除、图表、序列、
  外键选择与筛选搜索，并断言页面会话 GraphQL 请求为 0；测试记录与审计最终归零。

后续非资源表面：旧栈的定时行情刷新 scheduler 与当前无消费者的 `MarketQuote.take` 读取辅助
接口尚未迁移；在旧后端退役前另行处理，本 PR 不删除旧后端。

## PR-2.10 客户、供应商、员工（已关闭）

2026-07-26 完成最终验收；三个资源状态已更新为“已完成”。

- `.scratch/migration/capture_party_employee_contract.exs` 从迁移前 Elixir 真实捕获 superadmin 与
  read-only Actor 的 6 份 GridMeta，固化在 `snapshots/pr-2.10/`；Go Meta 逐 JSON 语义对拍，
  只读 Actor 可读且 capabilities 为空，三个资源均无扩展动作。
- `.scratch/migration/capture_employee_code_graphql.exs` 实证旧 GraphQL
  `CreateHrEmployeeInput.code` 为 `String!`：missing/null 在 schema 层拒绝；空串/纯空格才进入
  Ash，无规则报 action error，有规则自动取 `001/002`。探针全程位于同一数据库事务并显式
  rollback；归零核验为真实启用规则 1、测试规则/员工/审计 0。快照见
  `snapshots/pr-2.10/hrEmployees.code-input.graphql.json`。新 REST 将 missing/null/空白统一为
  “留空”属于 transport 归一化，不声称与旧 GraphQL 三态等价。
- `bun .scratch/migration/verify-party-employee-rest.ts` 已在真实 PostgreSQL 通过，输出
  `party/employee REST acceptance ok: meta=6 customer=1 supplier=1 employees=6 enumArray=2 autoNumber=3 permissionFirst=9 audits=9 cleanup=0`。
  覆盖三资源 CRUD、搜索、必填/长度/唯一/枚举、员工 decimal 与
  enumArray、身份证 `[FILTERED]` 审计、客户物料与员工考勤引用删除冲突，以及畸形 JSON 在
  解码前按权限返回 403。普通 enum 大小写回归、正常 API 清理、异常 finally 收口和审计归零
  同时通过。
- 前端三个页面、三个 Drawer、registry、考勤导入权限 Meta 与 employee decimal adapter 已切至
  ResourceClient；专项静态契约 5/5、当前前端全量测试 45/45、OpenAPI、typecheck、check 与 build 已通过，
  目标业务 GraphQL marker 静态扫描为 0。
- Chromium `party-employee.go.e2e.ts` 定向 1/1 通过；覆盖三页 Grid/Drawer CRUD、员工
  decimal/null、参保筛选、REST 请求清单、会话 GraphQL=0 与测试记录/审计精确归零。当前
  全量 Go Chromium 回归 12/12 通过。
- 产品与术语复核：`docs/产品文档/基础资料.md` 已做一处最小纠正，明确客户被客户物料
  引用时禁止删除，供应商及客户其他多态引用仍不检查；`CONTEXT.md` 仅审阅、未修改。

## PR-2.11 库存域超级批次（已关闭）

2026-07-26 一次关闭物料分类、物料、物料单位转换、仓库、库存分录、手工出入库单及行、
手工调拨单及行、库存盘点单及行共 11 个资源；严格进度与 PR-2.10 合并由 **21/100**
更新为 **35/100**。

- 22 份迁移前 GridMeta 快照逐 JSON 语义对拍 superadmin/read-only Actor；Go Meta 保留
  扩展动作声明顺序和只读描述符，同时按目标资源 read 权限降级 FK/poly ref，能力仍严格裁剪。
- sqlc、Go service/HTTP、OpenAPI 与 11 个 ResourceClient 已接通。库存事实模块以
  `Post / Cancel / Balance` 为深接口，调用方持有事务；仓×物料键排序后取事务级 advisory
  lock，避免并发抢货穿透。单据系统投影列只由模块内路径回写。
- 真实 PostgreSQL 覆盖库存并发、负库存、余额/作废、出入库、调拨发货/足额或部分收货、
  盘点刷新/快照过期/审核/作废；完整 `go test ./... -count=1` 全量通过。
- REST 严格验收输出
  `inventory REST acceptance ok: meta=22 permissionFirst=10 master=4 stockDocs=2 transfer=1 count=1 entries=7 balances=3 audits=7 cleanup=0`；
  覆盖权限先于 JSON 解码、主数据与三类单据生命周期、库存流水/余额/审计及精确清理。
- 前端分类、物料、仓库、库存余额、库存流水及其他库存单三 tab 全部显式使用 REST client；
  共享物料单位选择器、仓库选择、FK 速览与跨页面 registry 同步切换，目标范围静态
  GraphQL marker 为 0。
- 前端 `openapi`、`typecheck`、45/45 测试、组件 checks 与生产 build 全部通过；
  `inventory.go.e2e.ts` 定向 1/1 通过，完整 Go Chromium 12/12 通过并断言库存会话
  `/graphql` 请求为 0。
- 专用空数据库从 `00001` baseline 顺序迁移至 `00003` 成功，验证后精确删除；产品文档已
  消除“公司与三仓同事务”却“种子失败不阻断公司创建”的矛盾，`CONTEXT.md` 保持原子口径。
- 迁移只新增/修改 Go、REST、前端与迁移验收资产；旧 Elixir 后端未编辑、未删除。

## PR-2.12 总账引擎与手工凭证（已关闭）

2026-07-26 关闭总账分录、手工会计凭证及凭证行共 3 个资源；严格进度由 **35/100**
更新为 **38/100**。

- `accGlEntries`、`accGlJournals`、`accGlJournalLines` 的 superadmin/read-only 共 6 份
  GridMeta 与迁移前快照逐 JSON 语义对拍；只读 Actor 仅保留 read，凭证的 audit/cancel
  扩展动作按权限裁剪。
- sqlc、Go service/HTTP、OpenAPI 与三个 ResourceClient 已接通。凭证头行仅草稿可改，
  行公司与币种从凭证/科目派生；审核在同一事务内锁定头行、复检两行/单边金额/借贷配平/
  科目与四类对手，并调用唯一 GL 引擎追加分录；取消整组标记作废，银行对账引用时返回 409。
- 真实 PostgreSQL 测试覆盖缺过账日期、零行审核回滚、并发审核仅一次成功、审核后冻结、
  分录生成、取消/重复动作拒绝、公司范围、头删行级联及审计；固定
  `golang:1.26.4-alpine` 执行 `go test ./... -count=1` 全量通过。
- REST 严格验收输出
  `accounting REST acceptance ok: meta=6 permissions=9 companyScope=single/multi/all/empty journalCRUD=1 lineCRUD=3 audit=1 entries=2 arAp=1 cancel=1 cleanup=0`；
  另覆盖无启用规则时自动编号拒绝、临时规则生成 `AUTO-001`、银行对账阻断取消后解除成功，
  业务记录、编号规则/计数器及审计最终精确归零。
- 会计凭证、总账分录、应收应付三页面与共享保存并审核、银行对账凭证选择均显式使用 REST
  client；前端专项契约确认业务 GraphQL marker 为 0。`openapi`、`typecheck`、51/51 测试、
  组件 checks 与生产 build 全部通过，build 仅保留既有大 chunk 警告。
- Chromium `accounting.go.e2e.ts` 由主线程定向复跑 1/1 通过（21.4 秒），覆盖两行草稿审核、
  分录页查询、应收应付余额与下钻、凭证取消，断言页面会话 `/graphql=0` 并精确清理夹具。
- `docs/产品文档/总账财务.md` 与 `CONTEXT.md` 已同步手工凭证状态机、审核/取消原子边界、
  四类往来对手、自动编号及银行对账取消保护；旧 `backend/` 未编辑、未删除。

## PR-2.13 销售/采购报价对称超级批次（已关闭）

2026-07-26 一次关闭销售与采购报价头、条目、价格档共 6 个资源；严格进度由
**38/100** 更新为 **44/100**。

- `.scratch/migration/capture_quotation_contract.exs` 从迁移前 Elixir 捕获 superadmin 与
  read-only Actor 的 12 份 GridMeta 快照；Go Meta 逐 JSON 语义对拍。旧销售/采购报价
  PostgreSQL 测试基线复跑为 47 passed。
- sqlc、Go service/HTTP、OpenAPI 与 6 个 ResourceClient 已接通。一个深的
  `domain/trading/quotation` 模块以受控 side 配置承载两侧共用的父单锁、状态机、快照、
  定价与审计规则，同时保留销售客户料限制及两侧对手/编号/资源名差异。
- 真实 PostgreSQL 覆盖两侧 CRUD、默认币种、手填/自动编号、对手与客户料差异、合法单位、
  固定价/数量梯度、切固定价清档、审核门槛、状态冻结、公司范围与级联；并发审核断言恰好
  1 次成功、1 次冲突、1 条审核日志。empty company scope 携筛选参数的回归用例钉住
  fail-closed 返回空集而非 SQL 500。
- REST 严格验收输出
  `quotation REST acceptance ok: meta=12 permissionFirst=34 companyScope=single/multi/all/empty salesCRUD=head/item/tier purchaseCRUD=head/item/tier numbering=manual/default/reject/auto candidates=currency/date auditRows=74 cleanup=0`。
- 销售/采购报价的两个 Grid、三态抽屉、条目/价格档编辑表及订单有效报价候选均显式使用
  REST client；专项契约 6/6 通过，目标报价 GraphQL operation 静态扫描为 0。审核弹窗遵守
  服务端 200 条分页上限。
- Chromium `quotation.go.e2e.ts` 定向 1/1 通过（15.0 秒），覆盖销售与采购各一张固定价+
  数量梯度混合报价的创建、审核、销售过期展示、有效候选读取及采购作废；两个报价页面
  会话 `/graphql=0`，业务夹具和审计精确归零。
- 固定 `golang:1.26.4-alpine` 执行 `go test ./... -count=1` 全量通过；前端 OpenAPI 生成、
  typecheck、57/57 测试、组件 checks 与生产 build 全部通过。产品文档、`CONTEXT.md` 与既有
  报价 ADR 已复核，本批只迁移实现、不改变业务规则或术语；旧 `backend/` 未编辑、未删除。

## PR-2.14 销售/采购订单与委外清单超级批次（已关闭）

2026-07-26 一次关闭销售订单头/条目、采购订单头/条目及采购委外材料/副产物清单共 6 个
资源；严格进度由 **44/100** 更新为 **50/100**。

- `.scratch/migration/capture_order_contract.exs` 从迁移前 Elixir 捕获 superadmin 与 read-only
  Actor 的 12 份 GridMeta 快照；Go Meta 逐 JSON 语义对拍。旧销售订单、采购订单、委外与
  需求串联 PostgreSQL 基线复跑为 124 passed。
- sqlc、Go service/HTTP、OpenAPI 与 6 个 ResourceClient 已接通。共享
  `domain/trading/order` 深模块用受控 side 配置统一父单锁、双币金额、报价解析、状态机、
  快照、审计与公司范围；采购侧在同一事务内扩展需求占用、BOM 预览和委外材料/副产物清单，
  报价模块仅暴露最小事务内解析 seam。
- 真实 PostgreSQL 覆盖销售固定价派生、采购阶梯价套档、常规/样品/零星、并发审核、
  审核后冻结、关闭/作废、需求池与并发占用/释放、BOM 损耗展开、委外两子表 CRUD、
  空公司范围及审计。固定 `golang:1.26.4-alpine` 执行
  `go test ./... -count=1` 全量通过；`sqlc 1.31.0 generate` 与 compile 通过。
- REST 严格验收输出
  `order REST acceptance ok: meta=12 permissionFirst=40 companyScope=single/multi/all/empty sales=fixed/audit/close/sample-void purchase=tier/audit/close demand=pool/occupy/release bom=expand materialCRUD=ok byproductCRUD=ok auditRows=19`；
  脚本退出后专用订单、报价、需求、BOM、主数据与审计精确归零。
- 销售/采购订单 Grid、三态抽屉、条目与委外两子表、审核弹窗、需求池、BOM 展开及统一
  收发货历史全部显式使用 REST；销售发货、采购入库、委外发料和委外入库四个下游候选同步
  改用结构化 REST 筛选。专项静态契约 6/6、目标订单 GraphQL operation 扫描为 0。
- 前端 OpenAPI 生成、typecheck、63/63 测试与生产 build 全部通过。Chromium
  `order.go.e2e.ts` 定向 1/1 通过（19.1 秒），覆盖销售固定价订单审核/关闭、采购阶梯价委外
  订单、BOM 展开、材料/副产物、需求占用/释放及审核/作废；目标 GraphQL operation 为 0，
  业务夹具与审计精确归零。
- 产品文档、`CONTEXT.md` 及订单/委外/需求/收发货历史 ADR 已复核；本批只迁移实现，没有
  修改业务规则或术语，故未重复改写领域文档。旧 `backend/` 未编辑、未删除。

## PR-2.15 标准与委外履约超级批次（已关闭）

2026-07-26 一次关闭销售发货头/条目、采购入库头/条目、委外发料头/条目，以及委外入库
头/条目/材料扣减/副产物共 10 个资源；严格进度由 **50/100** 更新为 **60/100**。

- 迁移前 Elixir 捕获的 superadmin/read-only 共 20 份 GridMeta 快照固化在
  `snapshots/pr-2.15/`；Go Meta 逐 JSON 语义对拍，四类头动作与十资源能力按权限裁剪。
- sqlc、两个 Go 深模块、OpenAPI、58 个 HTTP operation 与 10 个 ResourceClient 已接通。
  标准履约在同一事务串联状态、库存、GL、订单发/收投影、需求投影和审计；委外发料串联
  双仓库存与 issued 投影，委外入库串联成品/材料/副产物库存、加工费 GL、received/需求
  投影和审计。作废一律调用事实模块 `Cancel`，不生成 Reverse 分录。
- 真实 PostgreSQL 覆盖两侧 CRUD、来源与快照、单位折算、默认科目、同币、零金额、20%
  容差、对账阻挡、负库存与后续材料耗用的整事务回滚，以及审核/编辑、双单抢余量和同头
  双审核并发；订单投影专项 6 组测试通过。
- HTTP 契约覆盖全部履约 operation 在 JSON 解码和服务调用前先做权限拒绝，并钉住日期
  `YYYY-MM-DD`、decimal string 和大写枚举的 REST wire 口径。
- 四个头 Grid、四个条目 Grid、四个三态抽屉、六类嵌套编辑表、审核弹窗及默认科目读取
  全部显式使用 REST；科目、订单行、发料清单和委外清单候选使用结构化 FilterState。
  目标履约页面业务 `gqlFetch` 静态扫描为 0，专项契约 5/5 通过。
- REST 严格验收输出
  `fulfillment REST acceptance ok: meta=20 permissionFirst=10 queries=10 heads=4 defaults=1 cleanup=0`；
  Chromium `fulfillment.go.e2e.ts` 定向 1/1 通过，四类单据均由真实 REST 创建并在对应 Grid
  可见，目标页面会话 `/graphql=0`，业务夹具与审计精确归零。
- 固定 `golang:1.26.4-alpine`、真实 PostgreSQL 执行 `go test ./...` 全量通过；前端
  `check`、`typecheck` 与当前 SCM 契约测试 32/32 通过。迁移保持既有业务规则和术语，
  `docs/产品文档/` 与 `CONTEXT.md` 已复核，无需制造“已迁移”类领域定义；旧 `backend/`
  未编辑、未删除。

## PR-2.16 销售/采购对账与订单流批次（已关闭）

2026-07-26 一次关闭销售/采购对账头行、公司默认过账科目与统一订单收发货历史共 6 个资源；
严格进度由 **60/100** 更新为 **66/100**。

- 从迁移前 Elixir 捕获 6 资源 superadmin/read-only 共 12 份 GridMeta，并由 Go Meta 逐 JSON
  对拍。公司默认科目只开放 read/create/update、无 DELETE；订单流读取保持四个来源权限
  任一满足的 OR 语义并继续按公司裁剪，资源本身不制造虚假权限码。
- sqlc、销售/采购对称的统一对账深模块、默认科目模块、订单流只读模块、OpenAPI 34 个
  operation 与 6 个 ResourceClient 已接通。对账模块覆盖头行 CRUD、常规确认/撤回、
  赠送样品结单/作废、发票 close/reopen 事务 seam、金额与数量投影、todo、GL、审计及
  RepeatableRead 列表。
- 真实 PostgreSQL 覆盖销售/采购来源恰一、默认科目代入、金额链、状态机、同单与跨单并发
  恰好一次、投影/待办/总账回滚；常规销售候选另以查询专用 `orderType=REGULAR` 过滤样品
  订单来源，不扩张迁移前 GridMeta，测试先红后绿并验证来源切为 SAMPLE 后候选归零。
- HTTP 契约钉住全部入口权限先于 JSON 解码/服务调用，日期、decimal string、大写枚举及
  订单流 string ID wire 口径。增强后的真实 REST 验收输出：
  `supply reconciliation REST acceptance ok: meta=12 permissionFirst=41 sides=2 actions=8 defaults=1 nullSlots=4 noDelete=1 orderFlowOR=4 stringIds=1 candidateOrderType=2 graphql=0 cleanup=0`。
- 销售/采购头行 Grid、头 Drawer、Drawer 内条目表、审核确认弹窗和供应链默认科目设置均
  显式绑定 REST client；Chromium `reconciliation.go.e2e.ts` 定向 1/1 通过并断言会话
  `/graphql=0`。全量 Go Chromium 回归 17/17 通过；库存回归改为在多公司环境显式选公司，
  不再依赖“仅一家时自动选择”的数据库偶然性。
- 固定 `golang:1.26.4-alpine` 在真实 PostgreSQL 下执行 `go test ./... -count=1` 全量通过；
  前端 typecheck、71/71 测试、组件 `check` 与 client/SSR build 全部通过，build 仅保留既有
  大 chunk 警告。对账测试清理改为失败即报错并把可能等待锁的单位删除放到最后；历史遗留的
  5 组可识别 `RC/RO` 测试夹具已清理，重跑后公司/币种残留均为 0。
- `docs/产品文档/`、`CONTEXT.md` 及销售/采购对账、默认科目、订单流 ADR 已复核；本批仅迁移
  实现，没有修改业务规则或术语，故不重复改写领域文档。旧 `backend/` 未编辑、未删除，
  `.orig` 基线文件仍保留。

## PR-2.17 制造主数据与制造执行超级批次（已关闭）

2026-07-26 一次关闭工序、工艺模板头行、BOM 头及三类明细、需求头行、生产工单、生产入库
头行共 12 个资源；严格进度由 **66/100** 更新为 **78/100**。

- 从迁移前 Elixir 捕获 12 资源 superadmin/read-only 共 24 份 GridMeta；旧运行时没有独立
  RecordMeta，Drawer 复用 GridMeta。Go 的 12 个 Meta 构造逐 JSON 语义对拍，并保留模板/BOM
  子行复用父权限、制造主数据全局可见、执行数据按公司裁剪的边界。
- sqlc、制造主数据与制造执行两个深模块、OpenAPI 72 个 operation、HTTP 适配层与 12 个
  ResourceClient 已接通。主数据模块覆盖自动编号、引用删除、合法单位、多 BOM、模板路线
  事务快照；执行模块覆盖需求占用与状态机、并发工单唯一、入库库存事实、工单/需求投影、
  超入容差、审计及原路作废回滚。
- 真实 PostgreSQL 深行为测试覆盖搜索/筛选/排序、父子 CRUD、并发模板带入、并发销售占用、
  并发工单生成、同头双审核、审核与行编辑竞态、超入、负库存阻止作废，以及全部状态与库存
  投影回滚。固定 `golang:1.26.4-alpine` 执行 `go test ./... -count=1` 全量通过。
- REST 严格验收输出：
  `manufacturing REST acceptance ok: meta=24 permissionFirst=82 parentPermissions=18 global=3 scoped=2 crud=12 demandActions=5 salesOccupancy=1 concurrentConfirm=1 concurrentWorkOrder=1 outputAuditVoid=2 concurrentAudit=1 stockProjectionRollback=1 graphql=0 cleanup=0`。
  生产入库作废后，入库行仍按迁移前 `ON DELETE RESTRICT` 引用工单，因此工单 destroy 返回
  409；作废工单已足以释放需求行与需求单，此处按旧实现约束验收。
- 工序、工艺模板、BOM、需求、工单与生产入库六页及所有子表/动作显式绑定 REST client；
  目标制造页面静态 GraphQL 扫描为 0。Chromium 定向 1/1 通过（38.3 秒），六页 Grid、
  Drawer、子表和需求确认均走 Go REST，会话 `/graphql=0`，夹具与审计精确归零。
- 前端 OpenAPI 生成、typecheck、75/75 测试、组件 `check` 与 client/SSR build 全部通过，
  build 仅保留既有大 chunk 警告。`docs/产品文档/`、`CONTEXT.md` 与制造相关 ADR 已复核；
  本批只迁移实现，没有修改业务规则或术语。旧 `backend/` 未编辑、未删除，`.orig` 基线
  文件仍保留。

## PR-2.18 操作日志、待办与用户痕迹批次（已关闭）

2026-07-26 关闭操作日志、待办和逐用户待办痕迹共 3 个资源；严格进度由 **78/100** 更新为
**81/100**。

- 迁移前捕获证明只有 `sysAuditLogs` 是真实 GridMeta；superadmin/read-only 两份 11 列
  快照完全一致。`sysTodos` 与 `sysTodoStates` 的公开 resolver 均返回未知资源，后者也没有
  GraphQL 类型，因此 Go 端只注册操作日志 Meta，没有为两个内部资源制造虚假 Grid。
- systemops 深模块与 sqlc 查询目录覆盖操作日志只读查询、global/company 范围，以及 Todo
  active/history/recent、五个计算字段、逐用户已读/忽略、未读数；内部 Open/Close/StateUpsert
  保持 caller-owned 事务、同源 active partial unique 与 `(todo,user)` 唯一痕迹。公开 Todo
  wire enum 为大写，`sourceType` 保持 dotted lowercase，decimal 保持字符串。
- OpenAPI/HTTP 接通 Audit query/get 与 Todo query/read/dismiss/unread；所有公开动作先做权限
  拒绝，Todo/TodoState 不开放通用 CRUD。审计 `changes` 作为 JSON object 输出；Todo 返回
  company/createdBy 关系并保持 `acc.vat_invoice:create` 的旧权限复用。
- 操作日志 Grid/Drawer 显式使用只读 REST client；Todo 页面与铃铛经兼容 facade 全部切到
  REST，目标消费面 GraphQL operation 为 0。专项前端契约 3/3、22 assertions 通过。
- 固定 `golang:1.26.4-alpine` 的真实 PostgreSQL 测试覆盖 snapshot exact、权限优先、公司
  fail-closed、派生字段、逐用户隔离、mark/dismiss 并发、同源 active 并发以及内部事务提交/
  回滚。REST 严格验收输出：
  `system ops REST acceptance ok: meta=2 unavailableMeta=6 permissionFirst=7 readOnly=12 auditScope=6 todoBehavior=7 todoState=9 internalInvariants=3 graphql=0 cleanup=0`。
- Chromium 目标用例重复 2/2 通过，加入清理强断言后最终 1/1 通过（10.5 秒），覆盖日志
  Grid/Drawer、铃铛 recent、active/history、忽略与已读，会话 `/graphql=0`、夹具残留 0。
  验收中旧 `acc.vat_invoice:create` 在 VAT Invoice 尚未迁移、未进入 Go 权限目录时以既存
  数据库角色授权夹具恢复，登录、JWT 和 handler 仍走真实边界；财务批次注册该权限后消除此
  过渡夹具。
- 产品文档、`CONTEXT.md` 与既有领域定义已复核；本批只迁移实现，没有改变业务规则或术语，
  故不重复改写。旧 `backend/` 未编辑、未删除，`.orig` 基线文件仍保留。

## PR-2.19 考勤、补卡、薪酬与借款批次（已关闭）

2026-07-26 关闭原始打卡、考勤导入、日考勤、补卡、工资单、工资发放和员工借款共 7 个
资源；严格进度由 **81/100** 更新为 **88/100**。

- 从迁移前 Elixir 捕获 7 资源 superadmin/read-only 共 14 份 GridMeta，并逐 JSON 对拍。
  七资源保持全局 HR 范围；考勤导入完整复用 `hr.attendance_punch:import`，没有伪造独立
  权限或内部写接口。
- Go 深模块、sqlc、OpenAPI 35 个 operation、HTTP 适配与 7 个 ResourceClient 已接通；
  前端 5 个考勤页面和 3 个薪酬页面全部改用 REST，专项测试 4/4、42 assertions，全量前端
  82/82、539 assertions 与 TypeScript 检查通过。
- 真实 PostgreSQL 覆盖 `.dat` 解析、同 SHA 防重、不同批次相同打卡唯一冲突整批回滚、
  12:00 分桶与工时奖励、补卡重算、工资公式/刷新/批量生成整批回滚、工资发放行锁、正常/
  补发删除回退、自动借款归还与审计同事务；并发付余款精确 1 成功/1 冲突。
- REST 严格验收输出：
  `HR operations REST acceptance ok: meta=14 permissionFirst=19 internal=8 imports=31 attendance=17 corrections=8 payroll=24 payments=12 loans=9 audits=17 concurrency=5 graphql=0 cleanup=0`。
  Chromium 1/1 通过（40.1 秒），覆盖 8 页、9 个 HR REST 路径，会话 `/graphql=0`、
  `pageErrors=0`、夹具残留 0。
- 固定 `golang:1.26.4-alpine` 的 Go 全包与真实 PostgreSQL 测试通过；产品文档、
  `CONTEXT.md` 与既有 ADR 已复核，本批只迁移 transport/实现，没有修改业务规则或术语。
  旧 `backend/` 未编辑、未删除，`.orig` 基线文件仍保留。

## PR-2.20 资金银行、发票、费用报销与承兑票据批次（已关闭）

2026-07-26 关闭银行账户、银行流水、导入模板、导入批次、导入暂存行、银行对账、增值税发票、
报销单、报销行、承兑票据、承兑交易和持有承兑共 12 个资源；严格进度由 **88/100** 更新为
**100/100**。

- 从迁移前 Elixir 捕获 12 资源 superadmin/read-only 共 24 份 GridMeta，另冻结 GraphQL
  与 resolver 表面；Go Meta 逐 JSON 对拍。内部 refresh/link/register/rebuild 等 6 个写
  seam 没有被伪造成公开 REST，BillHolding 继续保持只读、无独立审计的单写者投影。
- 资金银行与财务单据两个深模块、两组 sqlc 查询、OpenAPI 65 个 REST operation、HTTP 适配
  与 12 个 ResourceClient 已接通。银行侧覆盖账户/流水约束、原生 xlsx 与 BIFF8 xls、
  FAILED 留痕、父批次锁与整批导入、双边容量对账、remaining 和 quick journal；单据侧覆盖
  发票/报销/承兑状态机、编号、对账与待办联动、GL A/B/C/D 原子事务、BillLedger 全链重放、
  持有段单写者和阿里云 OCR 稀疏预填。
- 固定 `golang:1.26.4-alpine` 在真实 PostgreSQL 下执行 `go test ./... -count=1` 全量通过；
  专项测试证明导入与对账并发串行、quick-create 失败不留凭证、发票/报销 GL 与引用保护、
  承兑并发双审恰一成功、后续已消费时前序作废的状态/GL/持有投影整体回滚。
- REST 严格验收输出：
  `finance operations REST acceptance ok meta=24 permissionFirst=40 internal=6 wire=46 scope=40 states=84 audits=9 concurrency=2 graphql=0 cleanup=0`。
  Finance Chromium 定向 1/1 通过（48.2 秒），九页与导入三层 Drawer、对账、发票/报销、
  承兑交易及持有动作均走 Go REST，`graphql=0`、`pageErrors=0`、`cleanup=0`。
- 前端 OpenAPI 生成、typecheck、86/86 测试（615 assertions）、组件 `check` 与 client/SSR
  build 全部通过；build 只保留既有大 chunk 警告。全量 Go Chromium 回归 21/21 通过
  （6.1 分钟），Finance 用例在全量序列中再次通过。
- `docs/产品文档/资金银行.md`、`发票.md`、`费用报销.md`、`票据.md` 与 `CONTEXT.md`
  已复核；本批只迁移 transport/实现，没有修改业务规则或术语，故无需重复改写领域文档。
  旧 `backend/` 未编辑、未删除，`.orig` 基线文件仍保留。

## 当前复核命令

- `SYNIE_TEST_DATABASE_URL=... go test ./...`
- `bun run openapi`
- `bun run typecheck`
- `bun test`
- `bun run build`
- `E2E_BASE_URL=http://127.0.0.1:3011 bun run e2e:go`
