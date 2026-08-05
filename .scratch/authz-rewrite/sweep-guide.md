# 扫荡迁移手册（工单 09-12 的操作手册）

来源：工单 06（files：via + owner）、07（需求单下发：assigned dept）、08（inventory 三单据：平凡多数模板）。
一句话：**模块零鉴权代码**——路由挂 `guard(资源, 动作)`，服务收 `Permit`，三个执行点由平台拥有。
范本按形态挑：公司域标准单据看 `modules/inventory/stock-doc-service.ts`；带部门/属主看 `modules/manufacturing/{demand,work-order}-service.ts`；多态宿主看 `platform/files/reachability.ts`。

## 1. 每资源迁移的固定步骤

按顺序做，每步都能独立编译/跑测：

1. **确认 meta 的 `authz` 声明**（`register` 已强制存在，扫荡期多数只需复核而非新增）
   - 有自己的 `company_id` 列 → `{ kind: 'company' }`（可空列加 `nullable: true`）。
   - 无公司列的全局主数据 → `{ kind: 'global' }`（seal 会防呆：global 却有 `company_id` 列即报错）。
   - 子行 / 只读投影 / 附属资源 → `{ kind: 'via', parent, fk }`。判断依据只有两条：
     它有没有自己的公司列（有也可以选 via），以及**判定语义是否应当递归单头**。
     子行答案恒为「是」→ 一律 via；来源单据多态（`voucher_type/voucher_id` 这类）无法静态 via，
     退回 `company`（见 `invStockEntries`）。
   - 只有在真有「按人/按部门看单」需求时才加 `owner` / `dept`。**不要顺手加**：
     `supportedScopes` 取同前缀各资源的交集，多声明一个维度就等于给矩阵多开一档，
     而没有绑定列的资源授了该范围会 fail-closed 成空集（用户看到的是「什么都没了」）。
2. **快照同步**（改了声明或资源集才需要，三处）
   - `src/platform/meta/catalog-seal.test.ts`：资源计数（新增/删除资源才动）。
   - `src/platform/meta/resource-authz.test.ts`：形态分布 `{ company, global, via }` + `supportedScopes` 期望表。
   - `web/app/lib/menu-permission-contract.test.ts`：新前缀必须有菜单归属（`relatedPermissions`）。
3. **路由挂 guard**（`requireAuth` 之后，逐端点）
   ```ts
   const docGuard = (action: string) => authz.guard(DOC_RESOURCE, action)
   .post('/stock-docs', docGuard('create'), zValidator(...), async (c) => {
     const item = await stockDocs.create(permitOf(c), c.req.valid('json'))
   })
   ```
   - 资源名常量从服务文件 export（`export const DOC_RESOURCE = 'invStockDocs'`），路由 import，不写字面量。
   - 动作名的唯一事实源是 **meta 的 actions**。meta 没声明的端点沿用最接近的已声明动作
     （盘点 `refresh` → `update`），**不要为了好看新增权限码**（新码要过目录/菜单/矩阵三处）。
   - 工作流动作逐个挂自己的码（audit/void/approve/cancel/ship/receive/dispatch…）。
   - 跨资源门控用 `allOf`，附加码从 `authz.targetOf(资源).prefix` 拼，不写字面量：
     `workOrderGuard('create', { allOf: [codeOf(DEMAND_RESOURCE, 'read')] })`。
   - 多码可读（旧 `readPermissionsAny`）用 meta 的 `authz.readAnyOf` 声明，或 guard 的 `anyOf`。
4. **服务签名 Permit 化**：`(actor, …)` → `(permit, …)`，构造函数收 `registry` 并在闭包顶部解析归宿：
   ```ts
   const docTarget = registry.authzTarget(DOC_RESOURCE)
   const itemTarget = registry.authzTarget(DOC_ITEM_RESOURCE)
   ```
5. **三个执行点替换**（模块里不应再出现公司/权限判断）
   | 旧形态 | 新形态 |
   |---|---|
   | `requirePermission(actor, code)` | 删（路由 guard 已判） |
   | `companyScopeWhere` + `empty` 早退 + `listFromSource` | `listAuthorized({ permit, target, alias, … })` |
   | `loadX` + `canAccessCompany`/`requireCompanyAccess` | `loadAuthorized({ permit, target, table, id, forUpdate? })` |
   | `loadX`（带 join 的投影）+ 公司闸 | `loadAuthorizedFrom({ permit, target, alias, source, select, mapRow })` |
   | create 里的 `canAccessCompany(input.companyId)` | `assertCompanyWritable(permit, input.companyId)` |
   | 手写 `created_by_id`/`owner_dept_id` | `permit.actor.userId \|\| null` / `withOwnershipStamp(values, permit, target)` |
   | `writeAudit(trx, actor, …)` | `writeAudit(trx, permit.actor, …)`（过账骨架同理传 `permit.actor`） |
   | 单公司聚合端点的公司闸 | `companyInPermitScope(permit, companyId)` → 不命中返回空结果 |
   - 私有 `lockDraftX(db, actor, id)` 一律改成闭包内 `loadAuthorized(forUpdate: true)` + 状态守卫两行。
   - 子行写路径：先取母单（`parentOf` → `loadAuthorized(forUpdate)` + 草稿门），再 `FOR UPDATE` 锁行。
     **加锁顺序必须母单先行**（原代码就是这个顺序，别为了少一次查询把顺序倒过来）。
6. **测试 Actor 换 testActor + 现取凭证**
   - 服务级测试：`createAuthzEnforcer(registry)` + `authz.decideFor(actor, 资源, 动作)` 取一张
     superAdmin 凭证（rowFilter 恒全集）够用，逐动作码门控放 HTTP 集成测试。
   - 若测试中途改写 actor（如补 userId），凭证要**每次现取**（`const permit = () => …`）。
   - HTTP 集成测试的角色授权直接写 `sys_role_permission`（矩阵范围 UI 是工单 13），
     `createTestAuth` 的 Actor 缓存 `ttlMs: 0`，改授权后同一 token 即刻生效。
7. **豁免清单删行**：`src/modules/authz-firewall.test.ts` 的 `EXEMPT` 删掉已迁文件，
   并把「豁免规模只减不增」的上限改成新的 size。**必须同步**：无僵尸项断言是双向卡
   （文件已无旧原语却还在清单 → 红）。

## 2. 已知坑全集

**SQL / 执行点**

- `listAuthorized` 的 `alias` 必须与投影子查询的别名**逐字一致**（`FROM (…) AS x` 就传 `x`，裸表就传表名）。
  写错不报错、不 typecheck，via 链的 EXISTS 会静默把行集算成空。**每条列表路径留一条回归断言**
  （断言「本公司的行在结果里」，不只断言「别人的不在」——后者对空集永真）。
- 列表与单条尽量共用同一份 `source`/`select` 常量（`stock-entry-service.ts` 的写法），别名就只有一处可写错。
- `loadAuthorizedFrom` 用于带 join 的 `get`；要行锁只能用 `loadAuthorized({ forUpdate: true })`（子查询不能 FOR UPDATE）。
- `FOR UPDATE` 与 WHERE 里的 EXISTS 可以共存（只锁主表行）。
- 跨资源聚合端点不要套行过滤：`compileRowFilter` 会把 dept/self 谓词编到不存在的列上
  （报「column does not exist」）。聚合只做码级门控 + 必要时 `companyInPermitScope` 的单公司边界。
- `ownershipStamp` 返回 `Record<string, string | null>`，直接 spread 进 kysely `.values()` 会破坏
  `InsertObject` 校验；用 `withOwnershipStamp(values, permit, target)`。
- `substring(path FROM $n)` 的 `$n` 必须显式 `::int`，否则 PG 选中正则重载，子树路径静默写错。

**声明 / 目录**

- `supportedScopes` 取同前缀各资源的**交集**：给子行选 `company` 会把母资源的 self/dept 交没 → 子行一律 `via`。
- `assertAuthzClosure` 的「global 不得有 company_id 列」防呆对 via 提前返回，
  故带 `company_id` 的子行只能是 `company` 或 `via`。
- 同前缀多资源要显式指定唯一 `printHead: true`，且 `permissionLabel` 必须一致（注册期校验）。
- 新增 fk 字段会自动进打印字段目录；渲染器对缺失占位符只输出空串，但 docbuilder 该补 join 就补。
- `readAnyOf` 的码必须在目录内，且该资源不进权限目录（无独立权限点）。

**路由 / HTTP**

- `guard` 必须挂在 `requireAuth` 之后：没身份时 `permitFor` 抛 401，挂错顺序会变 500。
- Hono 挂载点不匹配尾斜杠：集合根是 `/inventory/stock-docs`，写成 `…/` 会落全局 notFound（假 404）。
- `ApiError.validation` 是 **400** 不是 422。
- 入参校验（400）放在公司边界（404）之前：`fields` 校验 → `assertCompanyWritable`。
  否则 `companyId: ''` 这种会先撞公司边界，报「公司不存在」而不是「必填」。
- 服务层不再抛 `forbidden`：403 只由 guard 的码级判定产生。模块里若还剩 `forbidden` 文案，
  说明有判定没搬走。

**测试 / 环境**

- 测试库 `SYNIE_TEST_DATABASE_URL=postgres://synie:synie@127.0.0.1:5441/synie_test_authz`（与 dev 库分开）。
- 基线红（与本轮无关，别修）：hr / printing / market 三个 integration + order-draft 并行截断偶发红。
- 种子/示例数据不能用 `systemPermit()` 写有 `created_by_id` 外键的单据（system 用户 id 是全零、无 sys_user 行）；
  用真实 actor 现取凭证（`sampledata/inventory.ts:permitFor`）。`systemPermit` 只给纯受信任读/调度器。
- `restTransport` 的 `strictListLabel` 拒收 `fixedFilter`/`extraFields`：需要按公司收窄的前端页面不能带它。

## 3. 语义变化的固定披露格式

每个工单的 Comments 与 PR 描述都要有一张表，**逐路径**列，不要只写「统一为 not_found」：

| 路径 | 旧 | 新 |
|---|---|---|
| 单条读/改/工作流：跨公司 | `forbidden` 无权操作该公司数据 | `not_found`（xx 不存在） |
| create：目标公司未授权 | `forbidden` | `not_found` |
| 列表带 `companyId` 且该公司未授权 | `forbidden` / 全量泄露 | 空列表（领域筛选 ∧ 授权谓词） |
| 子行单条：母单不可达 | `forbidden` / 只按行公司列判断 | `not_found`（via 递归母单谓词） |
| 单公司聚合（余额等）：公司未授权 | `forbidden` | 空结果 |
| 某端点新增附加码 | 只要 A 码 | A ∧ B（缺码 `forbidden`，行不可达 `not_found`） |
| 前缀 `supportedScopes` | `[all]` | `[all, …]`（矩阵新增可授范围） |

规则：**403 只剩「码不满足」一种成因**；一切「存在但你看不到」都是 404 / 空集。
前端 QueryState 的提示文案随工单 14 收口，扫荡期只需把清单写清。

## 4. 完成定义（DoD）

1. `cd server && bun run typecheck` 干净（动了 wire/DTO 再跑 `cd web && bun run typecheck`）。
2. 单文件测试：本模块的 postgres/integration 测试全绿；至少补
   - 每条列表路径一条「本公司行可见」的别名回归；
   - 一条跨公司单条 404；
   - 一条缺码 403；
   - 一条状态守卫 409（证明领域不变量没被卷进权限系统）。
3. 全量 `SYNIE_TEST_DATABASE_URL=… bun test`：除基线红外全绿，数字写进 Comments。
4. `src/modules/authz-firewall.test.ts` 删行 + 规模上限下调，三例全绿。
5. 工单文件补 Comments：实施落点 / 声明与理由 / 语义变化表 / 坑 / 测试数字。
