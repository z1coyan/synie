# Plan 003: 以 ResourceBinding 竖切资源读写面

> **执行者说明**：本计划先建立可重复的迁移形状，再只迁移三个代表性资源。不要一次性搬完
> 当前 100 个资源，也不要用 `.filter()` 扫表复刻现有 SQL DSL。逐步执行并验证；遇到 STOP 条件
> 立即报告。完成后更新 `advisor-plans/README.md`。
>
> **漂移检查（首先运行）**：
> `git diff --stat 2da55d9..HEAD -- convex packages/shared/src web/app/lib/resources web/app/components/synie-data-grid web/app/components/synie-record-drawer web/app/components/synie-remote-select docs/adr .scratch/resource-catalog server/src/db server/src/modules/base server/src/modules/inventory`
> 若有变化，必须比对“当前状态”摘录；形状不一致即 STOP。

## 状态

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/002-establish-auth-and-application-kernel.md`
- **Category**: migration
- **Planned at**: commit `2da55d9`, 2026-07-31

## 为什么要做

前端已经有一个很好的后端替换 seam：ResourceBinding 把 Reader、Writer、Aggregate Draft、
Command 与缓存身份收口。真正不匹配的是查询模型：当前任意筛选/排序、`count(*)` 和 offset
分页建立在 SQL 上，而 Convex 要求静态 index/search index 和 cursor pagination。本计划把这种
差异一次收进 ResourceBinding/Catalog，再用币种、单位、仓库三个资源证明全链路。

## 当前状态

- `CONTEXT.md:7-12` 定义：Resource Catalog 是字段/查询能力/权限/表单声明的权威来源，但不
  执行领域规则或写入；ResourceBinding 的 Adapter 只翻译 transport。
- `docs/adr/2026-07-30-resource-catalog.md:54-69` 已把前端端口拆成 Reader、RecordWriter、
  AggregateDraftAdapter、CommandAdapter；`81-93` 明确 Catalog 永不成为写入引擎。
- 同 ADR `123-124` 明确否决“一次性迁移全部 97 个资源”，建议先以币种等简单主数据证明 seam。
- 2026-07-31 执行期重跑 `.scratch/resource-catalog/baseline/report.md` 后，当前基线为 100 个服务端
  资源、1416 字段、315 动作、96 个 frontend transport binding；相对计划时新增 3 个工单 BOM
  快照只读资源。迁移 manifest 必须对拍当前 sealed Catalog，禁止伪造旧的 97 数量。
- `web/app/lib/resources/catalog/types.ts:10-14,83-106` 当前接口为：

  ```ts
  export interface ResourceReader<TRow = Row> {
    query(input: ResourceQuery): Promise<ResourceList>
    get(id: string): Promise<TRow | null>
  }
  export interface ResourceBinding { reader; cache; writer?; draft?; commands?; loadDocument() }
  ```

- `web/app/lib/resources/registry.ts:329-359` 从所有 REST transport 一次装配规范 binding，未知资源
  fail-closed；这就是切换 Convex Adapter 的唯一入口。
- `web/app/lib/resources/types.ts:3-17` 暴露 offset 和必有 count：

  ```ts
  export interface ResourceQuery { limit: number; offset: number; search?; sort?; filter? }
  export interface ResourceList { count: number; results: Row[] }
  ```

- `web/app/components/synie-data-grid/SynieDataGrid.tsx:242-275` 以 page 算 offset，并以 count 算
  totalPages；CSV 也按 offset 分批。
- `packages/shared/src/filter.ts:7-47` 允许 contains/notContains/范围/任意可筛字段、动态 sort。
- `server/src/db/filterbuild.ts:28-57,213-227` 把上述动态 DSL 转为 SQL；`server/src/db/list.ts:79-89`
  对每次查询执行 `count(*)` 再 `LIMIT/OFFSET`。不能原样移入 Convex。
- `web/app/components/synie-data-grid/query.ts:3-4` 把 ID 限为 UUID。Convex document ID 是 opaque
  string，前端不得继续做 UUID 正则门控。
- `packages/shared/src/decimal.ts:3-21` 规定 wire 为十进制字符串、half-up、金额 2 位、单价 4
  位、数量 6 位；迁移不可改成 JS float。
- SQL 基线共有 105 个 `CREATE TABLE`、319 个 `REFERENCES`、77 个 `CHECK`、70 个 unique
  index。Convex schema validator 不会自动替代这些领域/引用约束。
- Convex 官方建议用 index 而非 `.filter()`，分页使用 cursor；默认事务上限还会把过滤掉的
  scanned documents 计入预算：
  <https://docs.convex.dev/database/reading-data/indexes/>
  <https://docs.convex.dev/database/pagination>
  <https://docs.convex.dev/production/state/limits>

## 需要使用的命令

| 用途 | 命令 | 成功预期 |
|------|------|----------|
| 生成 Convex 类型 | `bunx convex codegen` | `_generated` 更新，exit 0 |
| 推送 self-host | `bunx convex dev --once` | schema/functions 成功推送 |
| Convex 资源测试 | `bun test convex/catalog convex/resources` | 全部通过 |
| Web 资源测试 | `cd web && bun test app/lib/resources app/components/synie-data-grid` | 全部通过 |
| Web 检查 | `cd web && bun run check && bun run build && bun run typecheck` | 全部 exit 0 |
| 全仓类型 | `bun run typecheck` | exit 0 |

## 范围

**范围内：**

- `convex/schema.ts`
- `convex/lib/{ids,decimal,invariants,queryProfiles,pagination}.ts`（新建）
- `convex/catalog/**`（新建或扩展）
- `convex/resources/{currencies,units,warehouses}.ts` 及测试
- `convex/migration/{resourceManifest,tableManifest}.ts` 及检查脚本
- `packages/shared/src/{decimal,filter,meta}.ts` 与新增 cursor/query profile 契约
- `web/app/lib/resources/**`（只改通用 seam 和三个 pilot binding）
- `web/app/components/synie-data-grid/**`
- `web/app/components/synie-record-drawer/**`、`web/app/components/synie-remote-select/**`（仅 ID/
  pagination 接口调整）
- 三个 pilot 页面/Presentation Extension 的最小接线与测试
- `docs/adr/2026-07-31-convex-resource-query-profiles.md`（新建）
- 用户可感知分页行为若变化，对应 `docs/产品文档/移动端.md`
- `advisor-plans/README.md` 状态

**范围外：**

- 修改或删除 legacy `server/` 实现。
- 迁移除 `basCurrencies`、`basUnits`、`invWarehouses` 外的业务资源。
- GL、库存事实、编号、审计、文件、打印。
- 通用“按表名自动 CRUD”或运行期动态创建 index。
- 为保持 exact count 而每次扫描全表。

## Git 工作流

- 分支：`advisor/003-convex-resource-plane`
- 按“契约/manifest”“Catalog/query profile”“三个 pilot”“前端游标”提交。
- 建议提交：`feat(convex): 以 ResourceBinding 竖切基础资源`。
- 不 push、不开 PR。

## 步骤

### Step 1: 建立机器可校验的迁移总账

创建 `convex/migration/tableManifest.ts` 和 `resourceManifest.ts`：

- 每个旧 SQL table 必须有一项：`targetTable`、`mergedInto`、`projection` 或 `retired`。
- 每个当前 100 基线资源必须有 owner domain、旧表、target function module、query profiles、index、
  capabilities、权限 prefix、公司范围、decimal 字段、约束清单、frontend binding、status。
- `sysStorages` 先标 `planned-retired-by-006`，其余不得用含糊 `later`。
- 生成检查必须对照 SQL `CREATE TABLE` 和 Resource Catalog registry；数量不符时 CI 失败。
- status 只允许 `legacy | implementing | convex-verified | retired`。一个资源不能同时有 REST 与
  Convex writer。

**Verify**：`bun run check:convex-manifest` → 报告 105/105 tables、100/100 resources，0 未解释、
0 重复 authority；三个 pilot 状态为 implementing，其余 legacy。

### Step 2: 固化 Convex 值类型与不变量原语

实现并测试以下约定：

- 内部主外键用 `Id<'table'>`/`v.id('table')`；返回前端时映射 `_id → id: string`。移除通用
  UUID 校验，业务编号仍用现有字段，不新增冗余 public UUID。
- date 保存 `YYYY-MM-DD` canonical string，datetime 保存 UTC epoch milliseconds；在一个 codec
  模块转换，禁止各域自行 `new Date(string)` 猜时区。
- 扫描所有 SQL numeric/decimal 字段生成 decimal manifest：scale、允许正负、业务上限、
  `scaled int64` 范围证明。存储为 bigint，wire 经共享 codec 仍是 DecimalString，half-up 保持。
- 任何字段无法证明在 signed int64 范围内时 STOP；不要用 float 或不可排序 string 临时糊上。
- 建立纯函数 `assertExists`、`assertUniqueByIndex`、`assertDeleteAllowed`、enum/range/check guards 和
  `SynieErrorData` 映射。每个旧 FK/CHECK/unique 都必须在 manifest 指向 schema/index/guard/test。

**Verify**：对最小/最大/溢出、正负 half-up、2/4/6 scale、日期日界、opaque ID 做 table-driven
测试；`rg -n "v\.float64\(|Number\(.*amount|Number\(.*qty" convex` 无未经豁免命中。

### Step 3: 把 Resource Catalog 迁成可 seal 的 Convex 模块

沿用现有 ResourceDocument v2 和类型化定义，不创建第二套 DSL：

- 把 Catalog 纯声明移到可被 Convex function 与 web shared types 消费的模块；不能 import Hono、
  Kysely、Node fs 或 service。
- seal 阶段继续验证资源/字段/外键/布局/command/权限，并新增 query profile→schema index/search
  index 的静态对拍。
- Catalog query 按 `requireActor` 投影可见字段、capabilities 和 commands；服务端 mutation 仍
  独立鉴权，不能信任客户端投影。
- Presentation Extension 继续留在业务前端模块，Catalog 不下发 JSX/表达式。

**Verify**：seal 测试覆盖未知引用、重复资源、无 index profile、越权字段、未声明 command；
三个 pilot 的 ResourceDocument 与当前字段/label/form/permission fixture 对拍。

### Step 4: 用有限 query profile 取代任意 SQL 查询

定义统一 profile 形状，至少表达：profile key、相等前缀字段、最多一个范围字段、固定 sort、
search index、company scope、可选 exact counter key。三个 pilot 至少实现：

- `default`：固定主排序，cursor page。
- `lookup`：外键选择器所需 label/search/sort。
- `treeChildren`：仓库按 `companyId + parentId` 查询直接子层。
- `search`：只有确有搜索需求时使用 search index；不以 `.filter()` 做 contains。

客户端把筛选组合解析到**一个声明过的 profile**；无法解析时 fail-closed，并在 UI 禁用该组合
或显示“此组合暂不支持”，不得退回扫描。profile 参数必须由 `v` validator 白名单验证。

新分页接口统一为：

```ts
type ResourcePage<Row> = {
  results: Row[]
  pageInfo: { continueCursor: string | null; isDone: boolean }
  totalCount?: number
}
```

ResourceReader 接受 opaque cursor + `numItems`。legacy REST 的中央 adapter 可暂时把 cursor 编码
成 offset，但页面不再看到 offset；Plan 008 删除该 adapter。没有经过 projection/counter 维护的
查询不得返回 exact total。

**Verify**：架构测试禁止 `convex/resources/**` 使用 `.filter(` 或无 `.withIndex/.withSearchIndex`
的 `.query(...).collect/take/paginate`；每个 profile 有正向、非法组合、公司越权和 cursor 连续性测试。

### Step 5: 迁移币种、单位、仓库三个完整竖切

按 `basCurrencies → basUnits → invWarehouses` 顺序，每个资源完成：

1. schema/table/index/validators；
2. Catalog/ResourceDocument/query profiles；
3. get/list/create/update/delete mutation 和权限/公司范围；
4. 旧 unique/FK/delete restriction/check 的显式 guard；
5. 审计暂以 Plan 004 提供的接口占位为 internal hook，不能静默丢审计；在 Plan 004 合并前 pilot
   只在隔离测试环境写入临时 audit shape，并标 manifest blocked-on-004；
6. 对应 Convex ResourceBinding、basic form、remote lookup、tree children；
7. 旧 service tests 的行为 fixture 移植。

仓库要特别保留：公司内唯一、树父节点规则、只有叶子能承载库存、公司创建时三仓同事务 seed；
当前 `CONTEXT.md:42-47` 是权威业务规则，不以关系型 FK 行为替代。

**Verify**：每个资源独立运行 CRUD/permission/company/unique/delete/lookup tests；20 个并发同名
create 只有一个成功，其余 conflict；仓库 seed 任一步故障时三仓全不出现。

### Step 6: 让 DataGrid、Drawer、RemoteSelect 消费 cursor，而非 transport 细节

在 ResourceBinding 深模块一次调整：

- Grid 维护 cursor stack 和当前页号；next/prev 不要求 total pages。只有 `totalCount` 存在才显示
  精确总数，否则显示“第 N 页 / 已加载 N 条”。
- 卡片“加载更多”和 CSV 导出按 continueCursor 循环；检测 cursor 重复并中止，避免无限循环。
- cache key 包含 resource、profile、规范参数、cursor；仍由 binding.cache 拥有，不加入
  Convex function name/transport id 到页面。
- remote select 用 `lookup` profile；tree 只用 `treeChildren`。
- `id` 只要求非空 opaque string；清除 Grid、Drawer、remote select 的 UUID 正则。
- 在 Plan 002 的 convex mode registry 只注册三个 pilot；未迁移资源/菜单 fail-closed。legacy mode
  仍经中央 cursor→offset adapter 工作，页面无 env 分支。

**Verify**：ResourceBinding interface tests 同时跑 fake legacy 与 fake Convex reader；覆盖 next、
prev、搜索重置 cursor、筛选重置、卡片累积、CSV 全量、重复 cursor、无 total、opaque ID。

### Step 7: 完成真实 self-host E2E 和 ADR

在 convex mode 以首管理员跑：币种 CRUD/搜索、单位 CRUD/FK、公司范围仓库树/三仓 seed；另以
受限 actor 验证 Catalog 字段/command 投影与服务端拒绝。刷新浏览器时订阅继续，mutation 后当前
列表更新或精确 invalidation，不全 registry 清缓存。

ADR 记录 query profile、cursor、optional count、scaled int64、opaque ID、迁移 mode 及最终删除点。
如果 Grid 精确总页数在用户界面消失，更新移动端产品文档；不要把 Convex 实现细节写进产品文档。

**Verify**：`VITE_SYNIE_BACKEND=convex` 的 Playwright pilot spec 全绿；network 只出现 Convex/auth/S3
请求，不出现 `/api/v1/base/currencies|units|warehouses`。

## 测试计划

- Manifest：105 table、100 resource、constraint coverage、唯一 authority。
- Codec：decimal 边界/rounding/overflow、date/datetime、opaque ID。
- Catalog：seal、Actor projection、profile/index 对拍。
- Query：cursor 不重不漏、非法 filter/sort fail-closed、search、company scope、tree children。
- Mutation：CRUD、unique race、FK 不存在、被引用删除、仓库 seed atomicity。
- UI：Grid cursor、optional total、CSV、card load more、Drawer get、remote lookup。
- 真实 self-host E2E，不以 Cloud 或仅 `convex-test` 代替。

## 完成条件

- [x] Manifest 对拍 105/105 SQL tables、100/100 resources，无未解释项。
- [x] 三个 pilot 资源从 schema 到 UI 全部在 Convex mode 工作。
- [x] 所有 pilot 查询命中声明 index/search index，无 `.filter()` 扫描 fallback。
- [x] 前端通用接口已是 cursor；opaque Convex ID 不被 UUID regex 拒绝。
- [x] DecimalString wire/half-up/2-4-6 scale 不变，存储范围经 int64 证明。
- [x] Resource Catalog 仍只声明，mutation 保有领域写权威。
- [x] legacy mode 回归全绿，convex pilot E2E 全绿；没有双写/跨后端事务。
- [x] `bunx convex codegen && bun run typecheck && bun run test` 全绿。
- [x] ADR/必要产品文档更新，范围外无修改，索引状态 DONE。

## STOP 条件

- 任一 decimal 字段无法给出不溢出 int64 的业务范围。
- 产品必须保留任意字段组合筛选、任意 sort 和精确 filtered count，且不能接受预声明 profile/
  projection；这需要重新做产品/查询设计，不能扫描糊过去。
- pilot query 只有 `.filter()`/全表 collect 才能实现。
- 为支持 pilot 必须让一个业务事务同时写 legacy PostgreSQL 与 Convex。
- Resource Catalog 被要求生成通用 mutation 或解释聚合草稿。
- Convex opaque ID 必须伪装 UUID 才能通过未知外部集成；先报告集成边界。
- self-hosted 实际 limits 与官方文档/测试基线不一致并影响设计。
- 当前代码与摘录漂移。

## 维护说明

- 新增筛选/排序先加 query profile + index +测试，再开放 UI capability；禁止页面先开、后端扫描兜底。
- exact count 是维护成本显著的 projection，只给真正需要的用户场景，不把它恢复成所有列表默认。
- `scaled int64` 的 scale/bounds manifest 是数据契约；改 scale 等同数据 migration，需独立 ADR。
- migration manifest 贯穿 Plan 005/006/008，是最终删除 legacy 的机器闸门，不得变成手填后无人校验的文档。
