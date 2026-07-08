# 审计日志设计(sys_audit_log)

日期:2026-07-08 状态:待评审

## 目标与范围

记录资源数据变更(创建/更新/删除,含自定义写动作),单表支撑两个前端场景:

- 资源详情页的编辑记录组件:按 `(resource, record_id)` 查询
- 全局审计日志页:按时间/操作人/资源筛选,统一分页

范围外:登录日志、读取审计、版本快照与回滚(将来若需回滚,另行评估 ash_paper_trail,与本表不冲突)。本期只做后端与 GraphQL,前端组件后续单独实现。

## 存储:单表 `sys_audit_log`

资源 `SynieCore.Audit.Log`,仅内部写入、对外只读。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| resource | string | GraphQL type 名(如 `bas_currency`),前后端天然对齐 |
| record_id | uuid | 目标记录 id |
| record_label | string, null | 记录展示名:资源有 `:name` 属性时取变更后(删除时取删除前)的值,否则空。全局页展示用,记录被删后仍可读 |
| action_type | string | `create` / `update` / `destroy` |
| action_name | string | 动作名,自定义动作(如 `audit`)时与 action_type 区分 |
| actor_id | uuid, null | 操作人 user_id;系统内部操作(seeds 等)为空 |
| actor_name | string, null | 冗余存 username,人员删除后仍可显示 |
| company_id | uuid, null | 目标资源带 `company_id` 时冗余一份,用于数据权限过滤 |
| changes | jsonb | 字段级变更,格式见下 |
| inserted_at | timestamp | |

索引:`(resource, record_id, inserted_at desc)`(详情页)、`(inserted_at desc)`(全局页)。

`changes` 统一为 `%{"字段名" => %{"from" => 旧值, "to" => 新值}}`:

- create:仅 `to`(全部写入字段)
- update:仅变更字段,含 `from`/`to`;无实际变更(no-op)不落日志
- destroy:仅 `from`,存删除前全部公开属性(快照,作为追溯与手工恢复依据)
- `sensitive? true` 的属性(如密码哈希)一律不落值,记为 `"[FILTERED]"`

## 写入:一个全局 Change

`SynieCore.Audit.Track`(`Ash.Resource.Change`):

- 挂在 `on: [:create, :update, :destroy]`,after_action 中对比 `changeset.data`(旧值)与动作结果生成 diff
- 与业务动作同一数据库事务:业务失败不留脏日志
- actor 从 change context 取(`SynieCore.Authz.Actor` 的 `user_id`/`username`)
- 写入走 `Audit.Log` 的内部 create 动作,`authorize?: false`(受信内部路径,符合后端权限规范)

## 接入方式(侵入点)

Spark DSL fragment `SynieCore.Audit.Fragment`,内容只有挂 `Track` 的 changes 块。资源接入:

```elixir
use Ash.Resource,
  ...,
  fragments: [SynieCore.Audit.Fragment]
```

外加:受审计资源的 update / destroy 动作需 `require_atomic? false`(Ash 3 默认动作原子化,after_action 钩子无法原子执行;ash_paper_trail 有同样要求,属固有代价)。

每资源侵入合计:1 行 fragment + 每个 update/destroy 动作 1 行。将来若引入 `use SynieCore.Resource` 基座,fragment 行可归零。

本期接入:`bas_currency`、`bas_unit`、`bas_company`、`sys_user` 及 authz 写敏感资源(`sys_role`、`sys_role_permission`、`sys_user_role`、`sys_user_company`)。`hello` 不接。

## 查询与权限

- GraphQL:`Audit.Log` 暴露只读 query(AshGraphql 标准 filter/sort/分页),详情页过滤 `resource + record_id`,全局页按时间/actor/resource 过滤,同一 query 两处复用
- 权限码:`permission_prefix "system.audit_log"`,`permission_actions ~w(read)`,policies 照 Test.Doc 样板(super_admin bypass + HasPermission)
- 多公司 fail-closed:`company_id` 非空的日志套 CompanyScope 过滤;`company_id` 为空(全局资源)仅需权限码即可见

## 已知约束

1. **bulk 原子操作绕过审计**:`Ash.bulk_update/bulk_destroy` 用 `strategy: :atomic` 不走 change 钩子。约定:受审计资源批量操作必须 `strategy: :stream`。
2. **审计表只增不改**:不提供 update/destroy 动作;保留策略(归档/分区)暂不做,量大再说。
3. **关联变更不记录**:仅记录属性变更,manage_relationship 产生的关联表变化由关联资源自身接审计覆盖。

## 测试

- `Track`:create/update/destroy 各一条(diff 格式、no-op 不落日志、sensitive 过滤、actor 与 company_id 落库)
- `Audit.Log` 读权限:无权限码不可读、公司数据 fail-closed、super_admin 可读
