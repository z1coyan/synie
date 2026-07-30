# 后端架构模块

> **2026-07-28 更新**：产品后端已切到 Bun/TS（`server/`）。下文原为 Go（`server-go/`）
> 分层设计的模块依赖说明，**分层意图仍适用**（platform / engines / domain、
> Resource Catalog、filterbuild 白名单、引擎写事实表唯一入口）；目录与技术栈以
> `server/README.md` 与 `docs/migration/2026-07-28-go-to-bun-ts-cutover.md` 为准。
> 历史 Go 树见 git tag `server-go-final`。

本文把迁移规划中的分层落实为可检查的模块与依赖规则。术语定义仍以根目录
`CONTEXT.md` 为准；早期 Go 迁移规划见
`docs/migration/2026-07-25-fullstack-meta-and-go-migration.md`。

## 设计原则

- 模块的 Interface 同时是调用面和测试面；HTTP handler 不承载领域规则。
- 平台模块不 import 业务域或事实引擎；事实引擎不 import 业务域。
- 跨域读取只有确有生产、测试两个 Adapter 时才在 `internal/ports` 建 Seam。
- `engines/gl` 与 `engines/inventory` 是写事实表的唯一入口；单据在同一个
  `pgx.Tx` 中调用引擎并更新受控投影。
- 现有 Bun/TS Meta Registry 的目标形态是 Resource Catalog。未知资源、未知字段、未知
  动作均 fail-closed；Grid 与基础 Form 从同一份按 Actor 投影的 ResourceDocument
  派生。目录不执行领域写入，已接受取舍见
  [`2026-07-30-resource-catalog.md`](../adr/2026-07-30-resource-catalog.md)。
- 固定 SQL 交给 sqlc；动态列表只由 Meta 白名单驱动的参数化 predicate builder 生成。

## 目录与依赖

```text
server/
├── cmd/synie                    # 组合根：config、DB、模块装配、进程生命周期
├── internal/http                # chi 路由、认证 middleware、绑定、错误映射
├── internal/platform
│   ├── auth                     # argon2id、JWT、登录限流
│   ├── authz                    # Actor、Permission.matches、公司范围
│   ├── iam                      # 用户、角色、授权矩阵与用户公司范围管理
│   ├── audit                    # 字段 diff 审计写入
│   ├── meta                     # ResourceMeta Registry 与 wire DTO
│   ├── files                    # 文件元数据与存储 Adapter
│   ├── numbering                # 统一取号
│   ├── print                    # FieldCatalog、Renderer、soffice
│   ├── settings                # 单行设置
│   └── todo                     # 来源单据派生待办
├── internal/engines
│   ├── gl                       # 总账事实引擎
│   └── inventory                # 库存事实引擎
├── internal/domain
│   ├── base                     # 公司、币种、单位、科目、行情主数据
│   ├── sales                    # 销售链
│   ├── purchase                 # 采购与委外链
│   ├── inv                      # 库存单据
│   ├── mfg                      # 制造
│   ├── acc                      # 财务单据
│   ├── hr                       # 人事考勤工资
│   └── setup                    # 初始化与 demo
├── internal/db                  # pool、sqlc 产物、filterbuild
├── internal/ports               # 已证明需要多 Adapter 的跨域 Seam
└── db
    ├── migrations               # goose 唯一 DDL
    └── queries                  # sqlc 固定查询
```

允许的依赖方向：

```text
cmd/synie → http → domain → engines → platform/db
                    └────────────→ platform/db
             └───────────────────→ platform
```

禁止：

- `platform → domain|engines`
- `engines → domain`
- `domain/A → domain/B` 的环；跨域协作经明确 Port 或由组合根编排
- HTTP handler 直接写业务表、总账分录或库存分录
- 单据绕过引擎直接 `INSERT acc_gl_entry|inv_stock_entry`

## 第 1 批模块 Interface

### Auth

输入用户名、密码和登录桶，输出 JWT 与 SessionUser。密码不存在与密码错误走相同
argon2id 校验路径；10 次/300 秒后限流。JWT 使用 HS256，`iss=synie`，有效期 7 天；
密钥只来自 `AUTH_SECRET`。

请求认证解析 JWT 后，每次从数据库构建 Actor；不把权限和公司范围固化进长期 Token。

### Authz

`Actor` 包含 `user_id`、`username`、`super_admin`、`all_companies`、
`permissions`、`company_ids`。`HasPermission` 按具体码、资源通配、域通配、全域通配
依次匹配；nil Actor 与未知权限 fail-closed。

### Resource Catalog

> **2026-07-30 已实施**：ResourceDocument v2、ResourceBinding、Basic Form、
> Presentation Extension、AggregateDraftAdapter 与 CommandAdapter 已完成 contract；
> 当前基线与后续回归记录在 `.scratch/resource-catalog/`。

所有业务模块的资源定义只在组合根显式注册一次；注册完成后 Catalog 必须 seal，
并跨资源校验字段、枚举、外键、布局字段引用与动作能力。Catalog 从权威
`ResourceDefinition` 投影带版本的 `ResourceDocument`，按 Actor 裁剪字段引用与
capabilities，并为动态列表派生不可变的 `ResourceReadSpec`。

前端单独获取并缓存完整 ResourceDocument。HTTP `ResourceTransport` 只暴露实际存在的
query/get/create/update/delete；`ResourceBinding` 将其收口为 `ResourceReader` 与可选
`RecordWriter`。聚合草稿和领域命令分别绑定 `AggregateDraftAdapter` 与显式
`CommandAdapter`，不提供 Proxy/action fallback。动态 React 行为只放在与业务模块
共置的 Presentation Extension，不能进入 wire 元数据。

### base/currency

模块在自己的事务内完成 CRUD 与审计。`iso_code` 创建后不可改；必须是三位大写字母且
唯一；被任一公司用作本币时不可停用。动态 query 经 `filterbuild`，不接受客户端列名
进入 SQL 标识符。

### base/company

公司模块在自己的事务内完成公司 CRUD、审计与默认三仓种子；本币必须启用，编号为创建后
不可改的两位英文字母。更新上级公司时沿父链校验任意深度循环。默认仓库写入委托给
`domain/inventory/warehouse` 的种子函数并复用调用者事务；后续完整仓库模块仍是
`inv_warehouse` 常规 CRUD 的唯一所有者。

## 过账模块模板

每个过账模块在实现前，于对应规格或 `.scratch` 工单写明：

```text
Module ID:
Commands:
Owned tables:
Engine writes (voucher_type):
Projection columns:
Single-TX description:
Contract tests:
API/E2E smoke:
```

模块完成定义以 R3 PR Plan 的 Definition of Done 为准。
