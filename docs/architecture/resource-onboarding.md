# 新增资源接入清单

一条一行；标注漏项后果：**[编译红]** typecheck 挡、**[启动红]** 任一测试/启动即抛、**[测试红]** 契约测试挡、**[静默]** 无自动闸门要人记住。

## 后端（server/）

1. 迁移：`server/db/migrations/` 新增迁移，`bun db:migrate`。漏 → 查表即错 **[启动红]**。
2. 列类型：`bun run db:codegen` 重生成 `src/db/types.d.ts`。漏 → service 写 SQL 报类型错 **[编译红]**。
3. Meta 声明：`modules/<域>/meta.ts` 写 `ResourceMeta`（name/permissionPrefix/permissionLabel/table/fields/actions 必填；form/lookup/print 按需）。
   - `classification`（presentation/interactive）必须声明，register 时强制。漏 → **[启动红]**。
   - `authz`（`company` / `global` / `via` 三选一）必须声明，register 时强制。漏 → **[启动红]**。
     公司域资源写 `{ kind: 'company' }`（公司列缺省 `company_id`，可空列加 `nullable: true`）；
     无公司列的全局资源写 `{ kind: 'global' }`（声明为 global 但表里有 `company_id` → seal 报错）；
     子行/派生/只读投影写 `{ kind: 'via', parent, fk }`，判定递归到宿主，不必自带权限点。
     行级范围按需加 `owner`（缺省 `created_by_id`，启用「仅本人」）与
     `dept: { column, mode }`（`stamped` 归属部门缺省 `owner_dept_id` / `assigned` 指派部门须显式列）。
     只读投影或 import-as-read 重载用 `readAnyOf` 声明可读码集合（声明即执行，且该前缀不进权限目录）。
   - `numbering: true`：单据头进自动编号目录（字段自 meta 派生）。漏 → 编号规则绑不了该单据 **[静默]**。
   - `audit: { enabled: true }`（exclude/extra 按需）：审计白名单自 meta 派生。service 接了审计而未声明 → **[启动红]**；service 根本没接 → 无审计 **[静默]**。
   - `attachments: { companyScoped }`：附件宿主，OwnerRegistry 由此派生。漏 → 该资源上传/挂接 400，前端用到才暴露 **[静默]**。
   - `todoSource`: 本资源开待办时声明 source_type，与消费域 registerSource 互为镜像断言。漏任一侧 → **[启动红]**。
4. Service：Kysely + `buildListQuery(toReadSpec(meta))`，动态列表只走 meta 白名单。
   授权走 Permit 凭证：`target` 取自 `registry.authzTarget(资源名)`（唯一解析点），
   列表 `listAuthorized({ permit, target, … })`、单记录 `loadAuthorizedFrom(…)`（带 join 的投影）
   或 `loadAuthorized({ forUpdate: true })`（裸表 + 行锁），create 用 `assertCompanyWritable` + `ownershipStamp`。
   模块**不得**再 import `requirePermission`/`companyScopeWhere` 等旧原语
   （`src/modules/authz-firewall.test.ts` 封路）。参照实现：`modules/iam/department-service.ts`。
5. Routes：模块 `routes.ts` 定义端点并挂进 `app.ts`；每个端点挂 `deps.authz.guard(资源名, 动作)`，
   handler 用 `permitOf(c)` 取凭证。漏挂 → 服务层取 Permit 即抛 **[测试红]**；
   漏挂进 app.ts → 前端 transport 取不到 ApiType 路由 **[编译红（web）]**。
6. 注册：模块 `register*Resources` 挂进 `platform/meta/register-all.ts`（唯一注册入口，禁止第二份列表）。漏 → 资源不进 Catalog，meta 404 **[测试红]**（catalog-seal 资源计数需同步 +1，是有意识变更的闸门）。
7. 装配：`composition.ts` 装配 service、`toAppDeps` 摊平。漏 → **[编译红]**。
8. 权限目录、编号目录、审计白名单、附件宿主、待办断言全部由 meta 派生，无需（也不允许）再手抄清单。

## 前端（web/）

1. Transport：`app/lib/resources/<域>.ts` 用 `restTransport('资源名', api.<路径>, ...)` 声明（decimal/datetime wire 字段、能力子集在此收口）。
2. Registry：`app/lib/resources/registry.ts` 的 transports map 加一行（全站唯一资源名单）；命令挂 `SEMANTIC_COMMAND_ADAPTERS`，聚合草稿挂 `DRAFT_ADAPTERS`。漏 → 用到即抛「未注册 ResourceBinding」**[静默]**（编译不红，页面打开才炸）。
3. 页面：`app/routes/_app/<模块>/<页面>.tsx`（SynieDataGrid + `resourceBindingFor`）；routeTree.gen 由 dev/build 自动生成。
4. Menu：`app/lib/menu.ts` 声明 + `server/src/platform/menu/catalog.ts` 镜像，code 约定 `menu.<模块>.<路径末段>` 且发布后不可改。漏任一侧 → menu 契约测试 **[测试红]**。
5. Extension 资源另需 presentation module + drawer config（presentation registry 对拍）。漏 → **[测试红]**。
6. Lookup 种子（可选）：`app/lib/resources/catalog/lookups.ts` 的 `LOOKUP_SEEDS` 仅当 RemoteSelect 需要在 Meta 未拉取时不退化才加 **[静默]**。

## 验证

- server：`bun run typecheck && bun test`。
- web：`bun run typecheck && bun test`。
