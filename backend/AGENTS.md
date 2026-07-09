# Synie 后端

## 权限

- 权限码 `域.资源:动作`(如 `sales.order:audit`),通配 `前缀:*`、`域.*`。
- 权限点由代码派生不入库:资源声明 `permission_prefix/0` 与 `permission_actions/0`。
- 资源接权限照样板 `apps/synie_core/test/support/test_domain.ex`(Test.Doc):authorizer + 三段 policies。
- 带 `company_id` 的资源:所有能写 `company_id` 的动作(含 update)都要挂 `CompanyAccessible` 校验。
- 公司数据权限 fail-closed:`sys_user_company` 显式授权才可见;`all_companies`/`super_admin` 例外。
- `authorize?: false` 仅限受信内部路径(actor 构建、seeds、测试夹具)。
- 新资源/新动作必须同步补前端中文标签:权限矩阵 `web/app/components/synie-permission-sheet/permission-labels.ts`、操作日志 `web/app/routes/_app/system/logs.tsx`(漏了原样显英文码)。
- `permission_actions` 只列用户视角的独立能力;衍生动作不设新权限点,策略里用 `{HasPermission, as: "create"}` 复用既有码(如科目模板初始化=批量新增)。

## GraphQL

- list 查询统一 `paginate_with: :offset`(read action 声明 `pagination offset?: true, countable: true`),不留扁平列表——前端 DataGrid/RemoteSelect 都按 `count`/`results` 结构消费。

## 审计

- 新可写资源默认接审计:`use Ash.Resource` 加 `fragments: [SynieCore.Audit.Fragment]`。
- 受审计资源的每个 update/destroy 动作加 `require_atomic? false`;显式声明的 destroy 需 `primary? true`。
- 受审计资源批量操作用 `strategy: :stream`(`:atomic` 会绕过审计)。
- 敏感字段必须标 `sensitive? true`,否则值明文进审计日志。
