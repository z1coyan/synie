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
- 多态引用(判别枚举/字符串 + 裸 uuid,无 belongs_to)要在前端渲染成外键:资源声明 `poly_refs/0`,GridMeta 反射为多态 fk 列(变体按目标资源 read 权限 fail-closed 裁剪);字符串判别的变体标签在 variants 映射里显式给 `{资源, 标签}`。
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
- 文件字节走 REST `POST/GET /api/files`(multipart/二进制不过 GraphQL);存储后端在 runtime.exs `:synie_core, :storages` 配置,新后端实现 `SynieCore.Storage.Adapter`。

## 审计

- 新可写资源默认接审计:`use Ash.Resource` 加 `fragments: [SynieCore.Audit.Fragment]`。
- 受审计资源的每个 update/destroy 动作加 `require_atomic? false`;显式声明的 destroy 需 `primary? true`。
- 受审计资源批量操作用 `strategy: :stream`(`:atomic` 会绕过审计)。
- 敏感字段必须标 `sensitive? true`,否则值明文进审计日志。
