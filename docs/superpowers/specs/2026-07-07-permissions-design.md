# Synie ERP 权限能力设计

日期:2026-07-07
状态:已与需求方确认

## 目标与范围

- **功能权限**:控制"谁能对哪个资源执行哪个动作"(操作/按钮级),RBAC 模型。
- **数据权限**:控制"谁能看到哪些行",第一期实现**公司维度**(ERPNext 式多公司管理,非多租户),部门维度预留扩展槽。
- 权限校验统一落在 Ash policies 层,GraphQL / 后续其他入口天然共享。

### 非目标(本期不做)

- 部门数据范围(本人/本部门/含下级)——仅预留扩展方式。
- 字段级权限、审批流。

## 一、功能权限(RBAC)

### 权限码

字符串 `域.资源:动作`,如 `sales.order:batch_delete`、`fi.voucher:audit`。

- 域前缀避免大型 ERP 下资源撞名。
- 支持通配符:`sales.order:*`(该资源全部动作)、`sales.*`(该域全部资源的全部动作),降低角色配置量。

### 动作集

默认动作集(导入/导出天然是批量语义,不再加 `batch_` 前缀):

```
create  delete  update  read  print  import  export
batch_delete  batch_update  batch_print
```

关键设计:默认集**可增减**——

- 资源可声明领域动作:`audit`(审核)、`unaudit`(反审核)、`post`(过账)、`close`(关闭)等。
- 资源可剔除不适用动作(如无打印概念的资源去掉 `print`/`batch_print`)。

### 权限点不入库

权限点由代码派生:每个 Ash 资源声明权限前缀与支持的动作,权限码 = `前缀:动作`。数据库只存"角色 → 权限码"授权关系。

- 好处:权限点与代码永不漂移,零 seed 数据维护。
- 角色配置界面通过一个枚举接口遍历所有资源的声明,动态生成权限树。

### 表结构

```
sys_role             id, code, name, enabled
sys_user_role        user_id, role_id
sys_role_permission  role_id, permission(text)   -- "sales.order:read" / "sales.order:*"
```

### Ash 落地

每个资源一条全局 policy,全项目共用一个 SimpleCheck:

```elixir
policies do
  bypass actor_attribute_equals(:super_admin, true) do
    authorize_if always()
  end

  policy always() do
    authorize_if SynieCore.Authz.HasPermission
  end
end
```

check 内部:从 resource 的权限前缀 + action 名派生权限码,与 `actor.permissions`(含通配展开)匹配。

- actor 权限集每请求从 `user → roles → role_permissions` 加载(两条索引查询),先不做缓存,慢了再加 ETS。
- 超级管理员:`sys_user.super_admin` 布尔,policy bypass,不参与权限码匹配。

### 前端支持

- `myPermissions: [String!]` GraphQL 查询下发当前用户权限码,前端控按钮/菜单显隐。
- 权限树枚举接口供角色配置界面使用。

## 二、数据权限(维度化过滤器)

核心思路:每个资源声明自己参与哪些**数据维度**,每个维度是一个独立的 Ash filter check,自动向查询追加过滤条件。**新增维度 = 新增一个 check + 资源声明,不改任何已有表**——这是防止后期打补丁的关键。

### 公司维度(第一期)

```
sys_company       id, code, name, parent_id   -- 树形,ERPNext 同款,支持后期集团/合并报表
sys_user_company  user_id, company_id
```

- 业务资源(订单、凭证等)带 `company_id` 列并声明 company 维度;共享主数据(物料、计量单位等)不带此列,天然全公司共享——对应 ERPNext 中 master 与 transaction 的区别。
- 授权**挂用户不挂角色**:"张三负责 A、B 两家公司"是人的属性,角色描述职能(销售员/会计),两者正交。
- **可见性语义:显式授权,默认不可见(fail-closed)**。用户必须被授予某公司才能看到该公司数据;新用户默认看不到任何业务数据。跨公司管理人员用 `sys_user.all_companies` 布尔覆盖。漏配置的后果是"看不到"而非"越权看到"。
- 读取:filter check 追加 `company_id in ^actor.company_ids`(被过滤的行静默不可见,不报错)。
- 写入:changeset 校验 `company_id` 在可用公司范围内,越权返回校验错误(见「三、错误处理」)。

### 部门维度(留槽,不实现)

后期:`sys_dept` 树 + 用户挂部门 + 角色上的 `data_scope`(本人/本部门/含下级/全部),作为独立维度 check 加入,不碰公司维度与现有表。

## 三、错误处理

- 功能权限不足:Ash `Forbidden` → GraphQL error,前端统一提示。
- 数据权限:读取走 filter(结果集收窄,不报错);写入越权返回校验错误(Ash.Error.Invalid,字段级消息「无权在该公司下操作数据」)。

## 四、测试

- `HasPermission` check 单测:精确匹配、通配匹配、无权限、super_admin bypass。
- 公司维度 check 单测:授权公司过滤、fail-closed(无授权记录 → 空结果)、`all_companies` 覆盖、写入越权拒绝。
- 选一个代表性业务资源做端到端 policy 测试(GraphQL 层)。

## 已确认的设计决策

| 决策 | 结论 |
|------|------|
| 权限点存储 | 代码派生,不入库;DB 仅存角色授权 |
| 权限码格式 | `域.资源:动作`,支持通配符 |
| 动作集 | 10 个默认动作,资源可增(audit 等)可减 |
| 多公司 | ERPNext 式单库多公司,`sys_company` 树形 |
| 公司授权归属 | 挂用户(`sys_user_company`),不挂角色 |
| 公司可见性 | 显式授权,默认不可见(fail-closed) |
| 部门维度 | 本期不做,以独立维度 check 方式预留 |
