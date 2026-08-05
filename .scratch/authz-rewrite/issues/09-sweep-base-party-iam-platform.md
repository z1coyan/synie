# 09 — 扫荡：base / party / iam / platform 杂项

**What to build:** 按 08 手册迁移 base（币种/公司/单位/科目/行情）、party（客商/员工/地址）、iam（用户/角色，含授权 sync 自身的门控）、platform 余量（printing/numbering/settings/todo/audit/setup）。要点：printing 的客户端提供 prefix + mode/arity 派生动作（S9/D9/D10）改为目录解析后 guard；todo 注册表析取（D6）改 anyOf 声明；settings/market 的 null-actor 与「受信任读」（D11/D12）改 systemPermit；setup 的 superAdmin 路由（D13）改主体判定；audit 的 nullable 公司列走声明。global 资源（币种/单位/物料分类等）声明 `global` 后断言矩阵无行级范围。

**Blocked by:** 08

**Status:** done

- [x] 各模块 routes 挂 guard、服务 Permit 化、本地包装删除
- [x] printing/todo/settings/market/setup/audit 的特殊形态按上述归宿落地
- [x] 相关集成测试全绿；封路豁免移除对应项

## Comments

### 实施落点

| 模块 | 服务 | 路由 |
|---|---|---|
| base 币种/单位 | `modules/base/{currency,unit}-service.ts` | `modules/base/routes.ts` |
| base 公司 | `modules/base/company-service.ts`（`loadAuthorizedFrom` 共用投影） | 同上 |
| base 科目 | `modules/base/account-service.ts`（唯一公司域） | 同上 |
| base 行情 | `modules/base/market/service.ts` | `modules/base/market/routes.ts` |
| party | `modules/party/{party,address}-service.ts` | `modules/party/routes.ts` |
| iam | `modules/iam/service.ts` | `modules/iam/routes.ts` |
| printing | `platform/printing/{service,catalog,docbuilder}.ts` | `platform/printing/routes.ts` |
| settings | `platform/settings/{service,single-row}.ts` | `platform/settings/routes.ts` |
| audit | `platform/audit/service.ts` | `platform/audit/routes.ts` |
| numbering | `platform/numbering/service.ts` | `platform/numbering/routes.ts` |
| todo | `platform/todo/service.ts` | `platform/todo/routes.ts` |
| setup | — | `platform/setup/routes.ts`（主体判定移入 `platform/authz/enforce.ts`） |

平台侧新增：`AuthzEnforcer.hasAction()`（S9 用）、`requireSuperAdmin()` 中间件（D13）、
`FieldCatalog.resourceNameOf()`（打印 prefix → sealed registry 资源名）。

### 声明与理由

- 本批 17 个资源里 15 个是 **global**（无公司列）：币种/单位/公司/客商/供应商/员工/地址/
  用户/角色/角色权限/角色菜单/行情品种/行情价点/打印模板/编号规则/编号计数器/系统设置。
  声明沿用批 0 已写好的 `{ kind: 'global' }`，本单只复核 + 断言矩阵无行级范围。
- **company**：`bas_account`（会计科目）。
- **company + nullable**：`sys_audit_log`（全局事件 `company_id IS NULL` 所有人可见）——
  批 0 已声明 `nullable: true`，本单把手滚的 `(company_id IS NULL OR company_id = ANY(...))`
  换成 `compileRowFilter`，编译形态与迁移前逐字一致。
- 一律不加 `owner`/`dept`：本批无「按人/按部门看单」需求，多声明一维只会给矩阵多开一档。
- `_sysTodosInternal`（不进公开 Registry 的内部 meta）补 `{ kind: 'company' }`，
  仅供 `compileRowFilter` 取公司列绑定；待办没有独立权限点，码级判定见下。

### 特殊形态落地

- **printing S9/D9/D10**：客户端给的是打印**前缀**（`sales.order`）。路由先 `resourceNameOf(prefix)`
  解析成 sealed registry 资源名（不在目录 → 400），再按 `mode + arity` 派生
  `print / batch_print / export`，最后 `permitFor`。64 个打印头里只有 4 个声明了打印动作；
  其余无权限点，按**主体种类** fail-closed（只有 superAdmin/system 放行，与迁移前
  「码不在目录内故不可授」的结果逐字一致），放行后取一张 `read` 凭证作行过滤器。
  字段目录/可用模板的多码可读改 guard `anyOf`（`sys.print_template:read` ∨ `prefix:print|export|batch_print`），
  裸函数 `canUseTemplates` 删除。
- **DocBuilder 接口**：`buildDocs(actor, ids)` → `buildDocs(permit, ids)`。
  两个实现（`manufacturing/work-order-docbuilder.ts`、`trading/order/docbuilder.ts`）的
  `loadHead + canAccessCompany` 换成 `findAuthorized`。语义上「能打印的行」= 该次打印授权触达的行集。
- **todo D6**：注册表析取改封闭代数的 `anyOf` 组合子（`todoPermit(actor, sources, 'action'|'unread')`
  直接调 `decide`），声明（TodoSourceRegistry）即执行；两处手滚公司谓词收编为 `compileRowFilter`，
  单条改 `loadAuthorized`。待办不进公开 Registry，故不新增权限码。
- **settings/market D11/D12**：`recordMarketFetch(actor|null)` → `(permit, …)`，调度器传
  `systemPermit(sysSettings,'update')` / `marketSchedulerPermit()`；`loadSystemConfig()` 内部
  显式 `systemPermit(sysSettings,'read')`；`market.takeQuote` 的裸函数受信任读改
  `systemPermit(basMarketInstruments,'read') + findAuthorized`。null-actor 分支清零。
- **setup D13**：`requireSuperAdmin` 从 setup 局部闭包提到 `platform/authz/enforce.ts`，
  作为封闭代数「主体种类」的唯一中间件；端点语义不变（仅超管），不新增权限码。
- **audit nullable**：见上。

### 语义变化表

| 路径 | 旧 | 新 |
|---|---|---|
| 科目单条读/改/删：跨公司 | `forbidden` 无权访问该公司 | `not_found`（会计科目不存在） |
| 科目 create / init-template：目标公司未授权 | `forbidden` 无权访问该公司 | `not_found`（公司不存在） |
| 审计单条读：他司事件 | `not_found`（同） | `not_found`（同，改由 `nullable` 声明编译） |
| 审计列表：全局事件（NULL） | 可见 | 可见（`(col IS NULL OR col = ANY($ids))` 声明形态，行为不变） |
| 待办列表/已读/忽略：缺全部源码 | 服务层 `forbidden` | 路由层 `forbidden`（decide anyOf 判定，403 成因唯一） |
| 待办 markRead/dismiss：无 userId | `forbidden` | `conflict`（不是权限问题，是缺主体的领域前置） |
| 待办单条：公司不可达 | `not_found` | `not_found`（同，改由 `loadAuthorized`） |
| 打印 render：资源前缀不在目录 | 400 validation（服务层） | 400 validation（路由层，先于任何判定） |
| 打印 render/field-catalog/templates：缺码 | `forbidden` | `forbidden`（同，改由 guard/anyOf） |
| 打印模板单条读/改/删 | `not_found`（同） | `not_found`（同，改由 `loadAuthorized`） |
| 各 global 资源单条：id 不存在 | `not_found` | `not_found`（同；global 无行级收窄，语义不变） |
| 各资源列表：缺码 | 服务层 `forbidden` | 路由 guard `forbidden`（成因唯一） |
| 全部前缀 `supportedScopes` | `[all]` | `[all]`（本批不新增可授范围） |

**未变**：本批 15 个 global 资源没有公司边界，迁移前后可见行集完全一致；
公司域只有科目与审计，二者的边界语义与迁移前等价（科目由 forbidden 统一为 not_found）。

### 坑

1. **打印动作码严重稀疏**：64 个打印头只有 4 个声明了 print/export/batch_print。
   直接对未声明动作调 `permitFor` 会撞 `assertActionDeclared` 抛 Error（500 而非 403），
   故必须先 `hasAction()` 判断、未声明走主体判定。别为了「好看」给 60 个资源补打印码。
2. **`guard` 的 `anyOf` 里可以放目录外的码**：`decide` 只做精确 Map 查找，
   不存在的码永不命中——这正是打印按 prefix 拼 `anyOf` 能成立的原因。
3. **子查询别名**：`company` / `account` / `sys_user` 三处 source 用的是
   `) AS company` / `) account` / `) sys_user`，`listAuthorized` 的 alias 必须逐字一致。
   新增的 `test/sweep-base-party-iam.integration.test.ts` 每条列表路径都留了「本行可见」断言。
4. **`createSingleRowSetting` 的类型会自动传导**：三个业务域 setting 包装用
   `Parameters<typeof inner.get>[0]`，改引擎签名后它们零改动即跟着变 Permit。
5. **计数器 meta 无 actions**：`sysNumberingCounters` 的 `actions: []`，
   guard 挂它会抛。计数器与规则同前缀，故路由一律用 `sysNumberingRules` 取凭证（门控码不变）。
6. **`sys.role_permission:*` 是矩阵目录用码，不是端点门控码**：角色授权 sync 的实际门控
   一直是 `sys.role:update`，迁移保持原样，别顺手换成看起来更"对"的码。
7. **`hr/attendance-service.ts` 仍在豁免清单**：它的自动建档分支改成了「分支内二次取 Permit」
   （注入 `AuthzEnforcer` + `decideFor`），但文件里还有 `requirePermission`，所以豁免不算僵尸。

### 测试数字

- `bun run typecheck`（server + web）干净。
- 全量 `SYNIE_TEST_DATABASE_URL=… bun test`：**538 pass / 4 fail / 542 tests / 82 files**。
  4 fail 全是既有基线红：hr（`meta.grid.capabilities` undefined）、
  printing（`printing/resources` 61≠64）、market（`form.exclude` undefined）、
  order-draft（并行截断偶发；单跑 5 pass）。
- **printing / market 基线红前后对比**：迁移前后失败在**同一断言**——
  printing `resources.resources.length` 期望 61 实得 64；
  market `metaBody.form?.exclude?.sort()` 期望三元组实得 undefined。既没修也没新增。
- 新增 `test/sweep-base-party-iam.integration.test.ts`：7 tests / 68 expect，全绿。
  覆盖手册 DoD 四类断言 + global 矩阵无行级范围 + 打印 S9 目录解析。
- `src/modules/authz-firewall.test.ts` 三例全绿；EXEMPT 38 → 28 行，上限 38 → 28。

### 豁免清单删行（10 行）

`modules/base/{account,company,currency,unit}-service.ts`、`modules/base/market/service.ts`、
`modules/party/{party,address}-service.ts`、`modules/iam/service.ts`、
`modules/manufacturing/work-order-docbuilder.ts`、`modules/trading/order/docbuilder.ts`
（后两个随 DocBuilder 接口改造顺势干净）。

`modules/sales/company-account-default.ts` **留给工单 10**：它的 `permissionPrefix` 是
`sales.setting`、表 `sal_company_account_default`、资源 `salCompanyAccountDefaults`，
属 trading/sales 域而非 base 域。

### 未尽事项

- 工单 10 收 `modules/sales/company-account-default.ts`（连带 `getByCompany/create` 的 Permit 化）。
- 工单 12 收 `hr/attendance-service.ts`、`hr/payroll-service.ts`（本单只做了自动建档分支的二次授权）。
- 打印的 60 个「无打印权限点」资源目前只有 superAdmin 能渲染；若产品要开放，
  应在对应 meta 显式声明 print/export/batch_print 动作（过目录/菜单/矩阵三处），而不是放宽路由。
- `platform/settings` 的 `/finance/ocr-configured` 仍只判「已登录」（无独立权限码），保持原样。
