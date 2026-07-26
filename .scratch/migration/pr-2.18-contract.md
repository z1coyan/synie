# PR-2.18 操作日志、待办与用户痕迹迁移前契约

记录日期：2026-07-26。本文只冻结旧 Elixir/Ash/GraphQL 与旧前端的实际表面，不新增
业务规则。范围严格为：

- `SynieCore.Audit.Log` / `sys_audit_log`
- `SynieCore.Sys.Todo` / `sys_todo`
- `SynieCore.Sys.TodoState` / `sys_todo_state`

事实来源按优先级为：

1. 三个旧 Ash Resource、`SynieCore.Audit.Track`、销售/采购对账与发票内部调用；
2. 真实 `SynieWeb.GridMeta.resolve/2` 与 GraphQL introspection 输出：
   `.scratch/migration/snapshots/pr-2.18/`；
3. PostgreSQL 迁移与旧 Ecto/PostgreSQL 测试；
4. 旧前端 `system/logs.tsx`、`lib/todo.ts`、`todos.tsx`、`todo-bell.tsx`。

## 可复现捕获与测试

```sh
cd backend
MIX_ENV=dev mix run \
  ../.scratch/migration/capture_system_contract.exs \
  ../.scratch/migration/snapshots/pr-2.18

MIX_ENV=test mix test \
  apps/synie_core/test/synie_core/audit/log_test.exs \
  apps/synie_core/test/synie_core/audit/track_test.exs \
  apps/synie_core/test/synie_core/sys/todo_test.exs \
  apps/synie_core/test/synie_core/authz/mount_guard_test.exs \
  apps/synie_web/test/synie_web/schema_grid_test.exs
```

固定 read-only Actor 持：

- `sys.audit_log:read`
- `acc.vat_invoice:create`

它没有公司授权。公司授权不改变 Meta，但真实数据查询时会使公司范围 fail-closed：
审计只剩 `company_id IS NULL` 的全局日志，待办为空。

## Meta 与公开性确证

三个资源不是三个通用 Grid。

| 资源名尝试 | GridMeta 白名单 | GraphQL 记录类型 | 公开根字段 |
|---|---|---|---|
| `sysAuditLogs` | 是 | `SysAuditLog` | `sysAuditLogs` |
| `sysTodos` | **否** | `SysTodo` | `sysTodos`、`sysTodoUnreadCount`、两个 mutation |
| `sysTodoStates` | **否** | **无** | **无** |

捕获脚本必须走公开信任边界 `SynieWeb.GridMeta.resolve/2`，不能直接调用
`GridMeta.build/2` 给白名单外资源制造一个迁移前不存在的 Meta。因此：

- `sysAuditLogs.{superadmin,read-only}.grid.json` 是两份真实 Meta；
- `sysTodos.*.grid-unavailable.json` 与 `sysTodoStates.*.grid-unavailable.json`
  固定公开 resolver 的真实错误 `未知的表格资源`；
- `graphql-surface.json` 固定 Query/Mutation 签名、`SysAuditLog`/`SysTodo` 字段，
  并以 `SysTodoState=null` 实证用户痕迹不公开。

### `sysAuditLogs` GridMeta

superadmin 与固定 read-only 完全相同，共 11 列：

`id, insertedAt, resource, recordId, recordLabel, actionType, actionName,
actorId, actorName, companyId, changes`

- `capabilities=[]`、`extendedActions=[]`、`destroyMutation=null`；
- `insertedAt` 是 datetime，可筛可排；默认查询排序仍是 `insertedAt DESC`；
- `resource/recordLabel/actionType/actionName/actorName` 可筛可排；
- `id` 可排不可筛；
- 三个 UUID 值 `recordId/actorId/companyId` 均退化为 string，可排不可筛；
- `changes` 在 Meta 中退化为 string，且不可筛不可排；GraphQL 实际标量为
  `JsonString`，即 JSON 字符串。

旧运行时没有独立 `RecordMeta`；操作日志抽屉复用同一 GridMeta。

## `Audit.Log` 数据与动作契约

### 字段与写入格式

| 字段 | 约束/语义 |
|---|---|
| `id` | UUID 主键 |
| `inserted_at` | 必填 UTC 微秒时间，写入时产生 |
| `resource` | 必填；优先取被审计资源 GraphQL type 名，否则取表名 |
| `record_id` | 必填，被操作记录 UUID |
| `record_label` | 可空；资源 `name` 等展示名的删除前/动作后快照 |
| `action_type` | 必填，`create/update/destroy` |
| `action_name` | 必填，实际 Ash action 名；业务动作可为 `audit/void/...` |
| `actor_id/actor_name` | 可空；取动作真正执行时的 Actor |
| `company_id` | 可空；有公司归属的资源冗余公司 ID，全局资源为空 |
| `changes` | 必填 map，键保持资源属性 snake_case |

`changes` 形状为：

```json
{
  "field_name": {
    "from": "旧值",
    "to": "新值"
  }
}
```

- create 只写非空值的 `to`；update 只写实际变化属性的 `from/to`；
  destroy 写删除前非空值的 `from`；
- 跳过 `id/inserted_at/updated_at`；
- `sensitive?` 属性值固定为 `[FILTERED]`；
- Decimal、日期时间、enum 等先转可 JSON 编码的稳定字符串；
- update 无实际变化时不写日志；失败动作也不留日志。

旧前端 GraphQL 收到 `changes` JSON 字符串后解析；迁移 REST 若直接使用 JSON object，
不得改变内层 `from/to` 和 snake_case 字段键语义。

### Ash actions、权限与事务

| action | 类型 | 公开 | 输入 | 权限/用途 |
|---|---|---|---|---|
| `read` | read | GraphQL list | filter/sort/offset/limit | `sys.audit_log:read` |
| `record` | create | **否** | 除 id/时间外全部日志字段 | `Audit.Track` 内部 `authorize?: false` |

- 资源对外只读、只增不改不删；不存在 create/update/destroy mutation。
- `read` 默认 limit 50、offset 可选、返回 count；默认 `inserted_at DESC`。
- superadmin bypass 全部权限与公司过滤。
- 普通 Actor 先须 `sys.audit_log:read`。`company_id IS NULL` 的全局日志可见；
  非空公司日志再按 Actor 公司范围过滤。空公司授权仍能看到全局日志。
- `Audit.Track` 是被审计动作的 `after_action` change，内部 `record` 与业务动作处于同一
  事务；日志写失败应使业务动作一起失败，业务动作回滚不得遗留日志。
- `Audit.Log` 自身不挂 Track，避免递归审计。

## `Sys.Todo` 数据模型

待办是源单状态推导出的物化提醒，不是通用任务/流程引擎：没有指派、截止日、优先级；
用户只留下已读与忽略痕迹。

| 字段 | 约束/语义 |
|---|---|
| `id` | UUID 主键 |
| `type` | 必填 enum：`ISSUE_INVOICE/开票`、`RECEIVE_INVOICE/收票` |
| `source_type` | 必填；仅现有 `sales.reconciliation`、`purchase.reconciliation` |
| `source_id` | 必填，源对账单 UUID |
| `source_no` | 必填，最多 64，源单号快照 |
| `party_type/party_id` | 必填，对手类型与 ID 快照 |
| `amount` | 必填 Decimal，默认 0；源对账单本币含税合计快照 |
| `status` | 必填只读 enum：`ACTIVE/活跃`、`CLOSED/已关闭` |
| `closed_reason` | 可空 enum：`UNCONFIRM/撤回确认`、`INVOICE_AUDIT/发票审核结单` |
| `source_changed_at` | 必填；源单状态变化时点、忽略复位基准 |
| `closed_at` | 可空只读；关闭时点 |
| `inserted_at/updated_at` | 必填 UTC 微秒时间 |
| `company_id` | 必填，源对账单公司 |
| `created_by_id` | 可空，触发确认的 Actor；发票作废/红冲复活时为空 |

数据库部分唯一索引固定：

```text
UNIQUE (source_type, source_id) WHERE status = 'active'
```

即一张源单同一时刻至多一个活跃待办；已关闭历史永久保留。

### 公开计算字段

这五个字段属于 `SysTodo` GraphQL 记录类型，虽无 GridMeta，迁移 REST 也不能漏：

- `draftInvoiceLinked`：按批次查 `acc_vat_invoice`；对应销售/采购对账单存在
  `status=draft` 的关联发票即 true。查询受信执行，不按 Actor 的发票读权限裁剪。
- `partyName`：按 `party_type` 到对手资源批量取 `name/short_name`；查不到或类型未知返回
  空字符串。它是当前主数据显示，不是落库快照。
- `myReadAt`：当前 Actor 的痕迹 `read_at`；无 Actor/无痕迹为 null。
- `myDismissedAt`：当前 Actor 的痕迹 `dismissed_at`；无 Actor/无痕迹为 null。
- `dismissed`：只有 `dismissed_at` 非空且 `reset_basis_at` 与当前 Todo 的
  `source_changed_at` 完全相等时才为 true。

列表 `read` 会一次加载上述五项。`company`、`createdBy` 关系也公开；旧前端实际读取
`company {id name shortName}`，不读取 `createdBy`。

## `Sys.Todo` 查询、动作与权限

### 公开表面

真实 GraphQL 根字段签名以 `graphql-surface.json` 为准：

- `sysTodos(filter, sort, limit=20, offset, tab, includeDismissed)`
- `sysTodoUnreadCount`
- `markReadSysTodo(id!, tab?, includeDismissed?)`
- `dismissSysTodo(id!, tab?, includeDismissed?)`

后两个 mutation 的 `tab/includeDismissed` 是 AshGraphql 为定位 update 目标机械带出的
可选 read argument；旧前端只传 `id`，迁移不应赋予它们新的业务含义。

`read` 规则：

- offset pagination 可选、countable，默认 limit 20、最大 200；
- `tab=active`：仅 active；
- `tab=history`：仅 closed；
- `tab=recent`：仅 active，并由服务端强制 limit 8；
- tab 为空或未知：不按状态过滤（内部/裸查询兼容事实）；
- active/recent 默认排除当前用户“有效忽略”的 Todo；
  `includeDismissed=true` 才包含；
- 未显式 sort 时为 `inserted_at DESC, id DESC`；显式 sort 覆盖。

权限没有 `sys.todo:*` 目录项。`permission_actions=[]`，所有用户公开动作复用
`acc.vat_invoice:create`：

- read、unread_count、mark_read、dismiss 均须该权限；无权限公开请求 Forbidden；
- read/update 再按 `company_id` 做 CompanyScope，持权限但无该公司授权时列表为空、
  单条更新不可达；
- superadmin bypass，可见所有公司；
- Todo 菜单本身不设独立权限门槛，数据按上述圈人规则收敛。

### 用户动作

| action | 效果 |
|---|---|
| `mark_read` | 触碰 Todo `updated_at`；当前 `(todo,user)` 痕迹 upsert `read_at=now` |
| `dismiss` | 触碰 Todo `updated_at`；痕迹写 `dismissed_at=now`、`read_at=now`、`reset_basis_at=todo.source_changed_at` |
| `unread_count` | 当前可见 active、未有效忽略且 `read_at IS NULL` 的 Todo 数量 |

- mark/dismiss 是 `require_atomic? false`，痕迹写在 Todo update 的 `after_action`，须与本次
  update 同事务。
- 两个动作只影响 Actor 自己；缺少 Actor user_id 时内部 helper 不写痕迹。
- `TodoState` 的所谓 upsert 实际是“先读再 create/update”，不是 PostgreSQL
  `ON CONFLICT`；唯一索引是并发首次点击的最后防线，旧实现无冲突重试。
- Todo 故意不接通用 Audit Track：个人点击高频低价值，产生/关闭已由源单据审计覆盖。

### 内部生产者动作

| action/API | 公开 | 语义 |
|---|---|---|
| `create_internal` / `open_for_sales_reconciliation!` | 否 | 创建销项开票 active Todo |
| `create_internal` / `open_for_purchase_reconciliation!` | 否 | 创建进项收票 active Todo |
| `close_internal` / 两个 `close_for_*_reconciliation!` | 否 | 关闭该源单全部 active Todo |

`open` 强制 `status=active`，在调用时生成 `source_changed_at=now`。`close` 只找 active，
写 `status=closed`、`closed_reason` 与 `closed_at=now`。这些动作均
`authorize?: false`，不能公开成任意 CRUD endpoint。

源单联动：

- 常规销售/采购对账单确认：同事务创建待办；
- 撤回确认：同事务以 `unconfirm` 关闭；
- 关联发票审核：发票事务内把对账单结单，并以 `invoice_audit` 关闭；
- 发票作废/红冲：同一发票事务把对账单退回已确认，**新建** active Todo；旧 closed
  记录留历史；
- 赠送/样品对账单审核即结单，不创建待办。

确认/发票动作在事务内对权威单据 `FOR UPDATE`；Todo partial unique index 再兜住并发
双开。重复并发 open 会触发唯一冲突并使所属源动作回滚，旧实现不吞冲突。关闭路径先读
active 再逐条更新；按索引正常至多一条。

每次 open/close 成功后发送 telemetry
`[:synie_core,:sys_todo,:changed]`，web 层桥接到 PubSub topic `sys_todo`。该戳不是
持久消息；旧浏览器没有 WebSocket 消费，轮询才是正确性兜底。

## `Sys.TodoState` 内部契约

字段：

`id, read_at, dismissed_at, reset_basis_at, inserted_at, updated_at, todo_id, user_id`

- `(todo_id,user_id)` 唯一；另有 `user_id` 索引；
- Todo 删除时痕迹 `ON DELETE CASCADE`；用户 FK 不级联；
- 无 company_id；它的隔离来自宿主 Todo 的公司范围与强制使用当前 Actor user_id；
- 资源未挂 AshGraphql extension、没有 GraphQL type/root field，也不在 GridMeta 白名单；
- `read`、`create_internal`、`upsert_internal` 的 policy 为 always，但仅被 Todo 内部
  `authorize?: false` 查询/写入调用；
- `create_internal` 接受两个 FK 和三个时点；`upsert_internal` 只接受三个时点，
  不可换 Todo 或用户；
- 不得为迁移便利把痕迹资源开放成通用 CRUD。

## 旧前端消费面

### 操作日志

- 菜单：`/system/logs`，通用 `SynieDataGrid(resource="sysAuditLogs")`；
- 页面不传 create/edit callback，只读查看；
- 列表隐藏 `recordId/actorId/companyId`；
- resource/action 用前端映射翻中文，漏映射则原样展示；
- `changes` 列表显示“n 项变更”，抽屉解析 JSON 后展示并可复制；
- `SynieRecordDrawer` 以 view 模式复用相同 GridMeta。

### 待办与铃铛

- `/todos` 为定制表格，不走 `SynieDataGrid`/ResourceClient，只提供 active/history 两 tab；
- `fetchTodos` GraphQL 读取所有公开计算字段与公司；Forbidden 被前端归一为空列表；
- 点源单号会先尽力 mark read，失败不阻断跳转；销售、采购分别跳到对应对账单页；
- 忽略调用 `dismissSysTodo`，刷新列表与未读数；
- 顶栏铃铛每 30 秒刷新 unread count，窗口 focus 也刷新；打开下拉才查 recent 8 条；
- 未读徽标显示上限 `99+`；铃铛展示 `partyName/company/amount/draftInvoiceLinked`；
- 旧 `fetchUnreadCount` 已切 `/todos/unread-count` REST，Forbidden 归一为 0；列表与两个
  用户动作在迁移前仍是 GraphQL。Go 迁移可统一 REST，但行为与字段不能缩水。

## 迁移验收清单

- 两份 `sysAuditLogs` Meta 做 JSON 语义对拍，尤其列顺序、map 降级与空能力集；
- `sysTodos/sysTodoStates` 必须保持“无公开 GridMeta”，不可用伪 Meta 代替定制面；
- Audit list 默认排序/limit、全局行与公司行可见性、只读动作面一致；
- Audit diff、敏感字段过滤、no-op/失败不落、业务事务回滚一致；
- Todo 两类型、两状态、两关闭原因、源字段快照与 partial unique 一致；
- tab/includeDismissed/recent 8/默认排序/count 与五个公开计算字段一致；
- `acc.vat_invoice:create` 圈人、CompanyScope、superadmin 三分支一致；
- mark read、dismiss、unread count 的逐用户隔离与痕迹事务一致；
- 对账确认/撤回、发票审核/作废/红冲与 Todo 同事务，历史不覆写；
- `TodoState` 保持内部、唯一、级联，不开放通用 CRUD；
- 操作日志页、待办页、铃铛的旧消费字段全部有 REST 等价面。
