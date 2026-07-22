# Synie 后端

## 开发库

- **环境变量**:`config/config.exs` 在 dev/test 自动加载 `backend/.env` 与 `backend/.env.<env>`(后者覆盖前者;进程已有变量优先)。prod 不读文件。
- 一键重置(仅 `MIX_ENV=dev|test`):`cd backend && mix synie.db.reset`——断开会话、`drop`/`create`/`migrate`。完成后打开应用走初始化向导,无需 `seeds.exs`。

## 权限

- 权限码 `域.资源:动作`(如 `sales.order:audit`),通配 `前缀:*`、`域.*`、`*`(全域,仅迁移种子/内置角色使用,业务代码不得写入)。
- 权限点由代码派生不入库:资源声明 `permission_prefix/0`、`permission_label/0`(中文资源名,随 catalog 下发)与 `permission_actions/0`。
- 角色授权整组保存走 mutation `syncSysRolePermissions(roleId, permissions)`(RolePermission 泛型动作 `:sync`):事务内 diff 增删,只同步当前 catalog 内具体码,通配码与目录外存量码原样保留,内置角色拒写,权限复用 `sys.role_permission:create` 码。
- 资源接权限照样板 `apps/synie_core/test/support/test_domain.ex`(Test.Doc):authorizer + 三段 policies。
- 带 `company_id` 的资源:所有能写 `company_id` 的动作(含 update)都要挂 `CompanyAccessible` 校验。
- 公司数据权限 fail-closed:`sys_user_company` 显式授权才可见;`all_companies`/`super_admin` 例外。
- `authorize?: false` 仅限受信内部路径(actor 构建、seeds、`SynieCore.Setup` 门面、测试夹具)。
- 新资源/新动作必须同步补前端中文标签:权限矩阵 `web/app/components/synie-permission-sheet/permission-labels.ts`、操作日志 `web/app/routes/_app/system/logs.tsx`(漏了原样显英文码)。
- `permission_actions` 只列用户视角的独立能力;衍生动作不设新权限点,策略里用 `{HasPermission, as: "create"}` 复用既有码(如科目模板初始化=批量新增)。
- 财务域全局配置(非公司维度)加字段进 `acc_setting` 单行资源(系统管理→财务设置),不另建配置表;系统级配置同理进 `sys_setting`(初始化完成时刻由 Setup 内部写;行情拉取节奏等经 GraphQL `sys.setting` 读写,界面在基础数据→基础设置→行情拉取 Tab)。

## GraphQL

- list 查询统一 `paginate_with: :offset`(read action 声明 `pagination offset?: true, countable: true`),不留扁平列表——前端 DataGrid/RemoteSelect 都按 `count`/`results` 结构消费。
- 多态引用(判别枚举/字符串 + 裸 uuid,无 belongs_to)要在前端渲染成外键:资源声明 `poly_refs/0`,GridMeta 反射为多态 fk 列(变体按目标资源 read 权限 fail-closed 裁剪);字符串判别的变体标签在 variants 映射里显式给 `{资源, 标签}`。
- 前端表格/抽屉依赖 `gridMeta`:新资源的 GraphQL query 名必须注册进 `apps/synie_web/lib/synie_web/grid_meta.ex` 的 `@resources` 白名单,漏注册前端报「未知的表格资源」并空转。
- 新单据接 GL(`GL.post!`/`cancel!`)时,`voucher_type` 必须同步注册进 `SynieCore.Acc.GL.voucher_resources/0`,分录来源单据列才渲染成链接。

## 自动编号

- 单据编号能力一律走 `SynieCore.Numbering`:create action 挂 `change {SynieCore.Numbering.AutoNumber, attribute: :编号字段}`,禁止业务代码自写取号/流水号逻辑。
- 挂了 AutoNumber 即自动进编号规则页的资源下拉(`numberableResources` 反射 create changes),规则在页面按资源配置,每资源仅一条启用。
- 计数范围 = 渲染后的非序号段文本 + 是否按公司,没有独立重置周期概念;`per_company` 依赖资源有名为 `company` 的 belongs_to。
- 编号留空自动取号、手填原样保留;校验/权限失败会跳号(取号在构建期,`allow_nil? false` 的必填校验先于 before_action),序号允许有洞。
- 前端接入方的编号字段改非必填,placeholder 提示「留空自动编号」。

## 文件/附件

- 一切文件/附件能力必须走统一文件接口:元数据只存 `sys_file`/`sys_attachment`,读写只经 `SynieCore.Files`(上传编排)与 `SynieCore.Storage` 门面;禁止业务代码直接读写磁盘、自建文件表或另开上传端点。
- 业务表挂附件零改动:走 `sys_attachment`(owner_type = graphql type 名 + owner_id);单文件字段直接加 `xxx_file_id` FK → `sys_file`。
- 文件字节走 REST `POST/GET /api/files`(multipart/二进制不过 GraphQL);存储接入在 `sys_storage`(系统管理→存储接入)维护,内置 local 由初始化向导完成时创建;新后端实现 `SynieCore.Storage.Adapter` 并在 `SynieCore.Storage` 的 `@adapters` 登记 kind。
- 新可挂附件的资源必须在 `SynieCore.Files.OwnerRegistry` 登记 owner_type→模块(否则其附件无法下载/挂接,fail-closed 预期代价)。附件公司隔离由挂接时从宿主去规范化的 `company_id` + 读策略(照 `sys_audit_log`:`is_nil(company_id)` 或 `CompanyScope`)自动获得。

## 审计

- 新可写资源默认接审计:`use Ash.Resource` 加 `fragments: [SynieCore.Audit.Fragment]`。
- 受审计资源的每个 update/destroy 动作加 `require_atomic? false`;显式声明的 destroy 需 `primary? true`。
- 受审计资源批量操作用 `strategy: :stream`(`:atomic` 会绕过审计)。
- 敏感字段必须标 `sensitive? true`,否则值明文进审计日志。
