# SynieDataGrid 设计

日期:2026-07-07
状态:已与需求方确认架构,待实现计划

## 目标

封装一个 `SynieDataGrid` React 组件:传入 Ash 资源名(即 GraphQL 查询名),自动渲染重型业务表格——每列服务端排序/筛选、offset 分页、行选择,`bulkActions`/`rowActions` 由调用方传入控制。

## 非目标

- grid 不生成 mutation。增删改的确认框、表单、权限差异太大,不值得泛化;actions 是纯回调。
- 不做列级权限控制(未来 ACL 落地后再议)。
- 不为此引入前端测试框架(仓库尚无前端测试设施)。

## 架构与数据流

```
Ash 资源 (graphql 块暴露 list 查询, read action 开 offset 分页)
  ├─ AshGraphql 自动派生 filter / sort / 分页参数(零手写筛选代码)
  └─ 新增 gridMeta(resource: String!) 查询:反射资源属性 → 列定义 JSON
        ↓
<SynieDataGrid resource="sysUsers" />
  1. 查 gridMeta → 列定义 {name, type, label, sortable, filterable, enumOptions}
  2. 据列定义动态拼行查询字符串(字段列表来自 meta)
  3. 排序/筛选/分页状态 → AshGraphql 变量,全部服务端执行,前端不做内存过滤
```

## 后端(约 80 行)

1. **资源暴露**:每个要上表格的资源在自己的 `graphql do` 块暴露 list 查询;对应 read action 开启 offset 分页。AshGraphql 按字段类型自动派生 filter/sort 输入类型。
2. **gridMeta 查询**:显式白名单 map(如 `"sysUsers" => SynieCore.Accounts.User`),resolver 用 `Ash.Resource.Info.public_attributes/1` 反射,返回每列:
   - `name`:camelCase 字段名
   - `type`:string / integer / decimal / boolean / date / datetime / enum
   - `label`:attribute 的 `description`,未写则回退字段名
   - `sortable` / `filterable`:布尔
   - `enumOptions`:enum 类型的取值列表(含 label)
3. **信任边界**:白名单外的资源名直接返回 GraphQL 错误,不做动态模块查找。

## 前端组件

依赖:`@heroui-pro/react`(私有 npm 包,token 在根 `.env`),使用其 DataGrid 组件。

### Props 契约

```tsx
<SynieDataGrid
  resource="sysUsers"            // 与后端白名单同名
  exclude={["hashedPassword"]}   // 可选:排除列
  overrides={{ status: { render: (v, row) => <StatusChip v={v} /> } }}  // 可选:覆盖单列渲染
  bulkActions={[{ key: "disable", label: "批量停用", isDanger: true,
                  onAction: (rows, { refetch }) => ... }]}
  rowActions={[{ key: "edit", label: "编辑", onAction: (row, { refetch }) => ... }]}
/>
```

### 行为

- **排序**:列头点击 → sortDescriptor → AshGraphql `sort` 变量。
- **筛选**:按列类型出对应控件——string→包含输入框、enum→多选、boolean→开关、date/number→范围。优先用 DataGrid 自带的筛选 UI,缺失部分用 HeroUI Popover 补列头筛选。
- **分页**:offset 分页,页码 UI。
- **Actions**:grid 负责选择态与按钮渲染;mutation 由调用方在 `onAction` 回调里自己发,回调收到 `refetch`。
- **DataGrid 集成边界**:SynieDataGrid 内部把上述状态映射到 DataGrid 的受控 props;DataGrid 的具体 API 以实现时 MCP `get_component_docs` 为准,SynieDataGrid 对外契约不受其影响。

### 类型边界(本方案唯一的代价)

行查询是运行时拼的,codegen 不覆盖:grid 内部行数据为 `Record<string, unknown>`,`overrides.render` 入参由调用方断言。表格之外的页面代码照旧走 codegen 强类型。

## 错误处理

- gridMeta 或行查询失败 → 表格错误态(HeroUI EmptyState/错误提示)。
- 白名单外资源名 → 明确 GraphQL 错误,不静默。

## 测试

- 后端 ExUnit:gridMeta resolver(sys_user 返回预期列);一条带 filter + sort + 分页的 GraphQL 查询走通。核心逻辑都在后端。
- 前端:试点页手动验收。

## 试点

`sys_user` 列表页(用户管理),验证排序/筛选/分页/bulk/row actions 全链路。

## 实现前置条件

1. master 上未提交的账户/登录工作先提交(本设计的试点依赖 sys_user 资源与登录)。
2. 实现会话需接通 `heroui-pro` MCP(`.mcp.json` 目前尚未配置,步骤见 README「HeroUI Pro」一节),用 `get_component_docs` 获取 DataGrid 实际 API。
3. 安装 `@heroui-pro/react`(token 在根 `.env`)。
