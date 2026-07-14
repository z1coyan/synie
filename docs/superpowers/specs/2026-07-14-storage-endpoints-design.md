# 存储接入与文件管理 设计

2026-07-14。已与用户确认:一并实现 S3 兼容 adapter;全局默认存储可切换;local 放 seed 幂等 upsert(不写死);批准后直通实现开 draft PR。

## 背景与现状

- 文件元数据存 `sys_file`(`storage` 列 = 配置名字符串,bucket/root 不入库),字节走 `SynieCore.Storage` 门面 → adapter。
- 现状只有 `SynieCore.Storage.Local` 一个 adapter;S3/阿里云 OSS 仅预留 behaviour,无依赖、无实现。
- 存储配置在 `config/runtime.exs` 的 `:synie_core, :storages` + `:default_storage`,UI 不可管理。

## 目标

1. 存储配置入库:新资源 `sys_storage`(存储接入点),系统管理页可增删改、可切换全局默认。
2. 实现 S3 兼容 adapter,s3 与阿里云 OSS 共用(OSS 走 S3 兼容 API)。
3. 系统管理新增两页:`/system/storages` 存储接入、`/system/files` 文件管理。

## 后端

### 资源 `SynieCore.Files.StorageEndpoint`(表 `sys_storage`,graphql `:sys_storage`)

沿用样板(bank_account):AshPostgres + AshGraphql + Policy.Authorizer + Audit.Fragment。

属性:

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string ≤32 | 接入名,唯一 identity(中文报错 message),格式 `^[a-z0-9][a-z0-9_-]*$`;写入 `sys_file.storage`,**建后不可改** |
| `label` | string ≤64 | 显示名,必填;`display_field` |
| `kind` | Ash.Type.Enum 模块 `StorageKind`(local/s3/oss,中文 description) | **建后不可改** |
| `root` | string | local:根目录(即"默认路径"),相对路径运行时 `Path.expand` |
| `endpoint` | string | s3/oss:服务地址 URL |
| `region` | string | 可空,签名兜底 `us-east-1` |
| `bucket` | string | s3/oss |
| `prefix` | string | 可空,对象 key 前缀(对象存储的"默认路径") |
| `access_key_id` | string | s3/oss |
| `secret_access_key` | string, `sensitive? true` | s3/oss;public(仅 `sys.storage` 权限可读,内部 ERP 已确认可接受),表格白名单不含它 |
| `builtin` | boolean 默认 false | 内置(seed 的 local),不可删;不进 create/update accept,seed 用 force_change 写 |
| `is_default` | boolean 默认 false | 全局默认,唯一 partial unique index(`WHERE is_default`);只经 `:set_default` 动作变更 |
| timestamps | | |

动作:

- `read`:offset 分页(约定)。
- `create`:accept 除 builtin/is_default 外全部;按 kind 校验必填(local→root;s3/oss→endpoint/bucket/access_key_id/secret_access_key),中文报错。
- `update`:accept 同 create 去掉 name/kind;`require_atomic? false`。
- `set_default`(update):accept [];change:before_action 先把其他行 `is_default=false`(bulk, `authorize?: false` 受信内部),再 `set_attribute(:is_default, true)`(顺序保证 partial index 不瞬时冲突)。策略 `{HasPermission, as: "update"}`(衍生动作复用既有码)。
- `destroy`:`primary? true, require_atomic? false`;validations:非 builtin(「内置存储接入不可删除」)、非 is_default(「默认存储接入不可删除,请先切换默认」)、无 `sys_file.storage == name` 引用(「仍有文件存于该接入点」)。

权限:`permission_prefix "sys.storage"`,`permission_actions ~w(create read update delete)`;三段 policies 照样板。权限目录自动派生,无需改 Registry。

接线:域 `synie_core.ex` 注册 list 查询 `:sys_storages` + create/update/destroy/set_default mutations + resource;`GridMeta.@resources` 加 `"sysStorages"`。

### `sys_file` destroy 增加挂接保护

destroy 加 validation:存在 `sys_attachment.file_id == id` 时拒绝(「该文件仍有业务挂接,请先在业务单据中移除附件」)。附件面板先删挂接再删文件的既有流程不受影响。

### Storage 门面改读数据库

`SynieCore.Storage` 公共 API(put/read/delete/presigned_url/default)不变,内部:

- `default/0`:查 `is_default == true` 行(`authorize?: false`)取 name;无行则抛「存储接入未初始化,请运行 seeds」。
- `conf!/1`:按 name 查行;kind→adapter 映射:local→`Storage.Local`(config `%{root}`),s3/oss→`Storage.S3`(config 含 endpoint/region/bucket/prefix/keys/kind)。查无此行中文报错。
- 退役 config 的 `:storages`/`:default_storage`(config.exs/runtime.exs/test.exs 一并清理);`UPLOADS_ROOT` 只在 seed 时读一次作为 local root 初值。

### S3 adapter `SynieCore.Storage.S3`

依赖:`ex_aws` + `ex_aws_s3` + `hackney` + `sweet_xml`。

- 每次调用从行配置构建 ExAws 覆盖配置(scheme/host/port 从 endpoint 解析 + region 兜底 + keys)。
- 对象键 = `prefix` 与 key 拼接(prefix 可空)。
- `put`:`put_object`(上传上限 50MB,单 PUT 足够);`read`:`get_object`;`delete`:`delete_object`(S3 删除天然幂等→:ok);`presigned_url`:`ExAws.S3.presigned_url`,下载走 FileController 既有 302 分支。
- 寻址风格:kind=oss 用 virtual-host(OSS 要求),kind=s3 用 path-style(MinIO/AWS 均可)。
- 无真实凭证,正确性验证:单测(键拼接、presigned URL 形状)+ 本地 MinIO 容器跑通 put/read/delete/presigned(打 `:minio` tag,默认 exclude,CI 不依赖)。

### seeds

`seeds.exs` 追加:按 `name == "local"` 幂等 upsert 一条(label 本地存储、kind local、root = `UPLOADS_ROOT` || `"uploads"`、builtin true、is_default true;builtin/is_default 用 force_change + `authorize?: false`)。已存在则跳过(不覆盖用户改过的 root)。

### 文档

backend/CLAUDE.md 文件/附件一节:「存储后端在 runtime.exs 配置」改为「存储接入在 sys_storage(系统管理→存储接入)管理,新后端实现 `SynieCore.Storage.Adapter`」。

## 前端

菜单:`menu.ts` system 模块新增分组「文件存储」:存储接入 `/system/storages`、文件管理 `/system/files`。

### /system/storages 存储接入

- DataGrid `sysStorages`,列白名单 `['label','name','kind','isDefault','insertedAt']`(密钥等详情进抽屉;白名单同时把 secret 挡在跨列搜索外)。
- RecordDrawer(view/create/edit):name/kind createOnly;kind effects 切换清空对侧字段;root 仅 kind=LOCAL 可见;endpoint/region/bucket/prefix/accessKeyId/secretAccessKey 仅 S3/OSS 可见;secretAccessKey view 态遮掩显示;builtin/isDefault 只读展示。
- 行动作「设为默认」:capability `update` 门控,当前默认行禁用;调 `setDefaultSysStorage`,成功后失效 `['gridRows','sysStorages']`。
- 增删改由 gridMeta capabilities 自动门控;删除保护靠后端中文报错。

### /system/files 文件管理

- DataGrid `sysFiles`,列 `['filename','storage','key','contentType','size','uploadedById','insertedAt']`;size 人类可读渲染;uploadedById 走 fk 反射。
- 只读 + 删除(内置批量删除走 `destroySysFile`),不提供新建/编辑(文件不可变,上传只经业务附件)。
- 查看抽屉(rowId 自查):全字段只读;footerActions「下载」(files.ts `downloadFile`);extraContent 挂接记录列表(`sysAttachments` filter `fileId`,展示 ownerType/category/挂接时间)。

### 标签补齐

`permission-labels.ts` 加 `'sys.storage': '存储接入'`;`logs.tsx` RESOURCE_LABELS 加 `sys_storage`(sys_file 已有则不动);`registry.ts` 加 sysStorages 抽屉配置。

## 测试与验证

- 资源测试:权限(无权/有权/super_admin)、name/kind 不可改、set_default 唯一切换、destroy 三重保护、kind 条件必填。
- 门面测试:storage_test 改为 DB 行驱动(local 临时目录 put/read/delete 走通、default/0、未知名报错)。
- files 上传链路测试补 seed 行。
- S3 adapter:单测 + MinIO tagged 集成测试;实现后用 MinIO 容器端到端验证(页面添加接入→设默认→业务附件上传→对象落 MinIO→下载→切回 local)。
- 前端:worktree 起前后端(PORT/BACKEND_PORT 覆盖,绑 0.0.0.0),Playwright 过两页主流程。

## 跟进项(不在本次)

- 接入点「测试连接」按钮(写删探测对象)。
- 密钥加密存储(cloak)如后续有合规要求。
- 按业务/公司选存储后端(当前统一走全局默认)。
