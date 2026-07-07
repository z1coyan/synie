# SynieDataGrid 设计

日期:2026-07-07(v2:加入权限驱动的标准动作)
状态:spec 先行,**暂不实现**——等系统有更多资源表、权限架构落地后启动

## 目标

封装一个 `SynieDataGrid` React 组件:传入 Ash 资源名(即 GraphQL 查询名),自动渲染重型业务表格——每列服务端排序/筛选、offset 分页、行选择;并根据**当前用户对该资源的权限**自动配置标准动作:新增、编辑、删除、打印、批量删除、批量导入、批量导出、批量打印。

## 非目标

- 增/改表单不泛化:grid 只负责按权限显示按钮,表单由页面在回调里提供。
- 除 destroy 外,grid 不生成 mutation(导入、打印的业务形态由回调承接)。
- 不做列级权限(字段脱敏/隐藏等 ACL 落地后再议)。
- 不为此引入前端测试框架。
- 跨页全选:v1 全选 = 当前页全选(DataGrid `selectedKeys: "all"` 的原生语义),批量动作作用于当前页选中行。

## 架构与数据流

```
Ash 资源 (graphql 块暴露 list 查询 + destroy mutation, read action 开 offset 分页)
  ├─ AshGraphql 自动派生 filter / sort / 分页参数(零手写筛选代码)
  └─ gridMeta(resource: String!) 查询,返回:
       ├─ columns: 反射资源属性 → 列定义
       └─ capabilities: 当前用户对该资源的能力集
             ↓
<SynieDataGrid resource="sysUsers" onCreate={...} onEdit={...} />
  1. 查 gridMeta → 列定义 + 能力集
  2. 据列定义动态拼行查询字符串;据能力集装配标准动作
  3. 排序/筛选/分页状态 → AshGraphql 变量,全部服务端执行
```

## 后端

### 1. 资源暴露

每个要上表格的资源在自己的 `graphql do` 块暴露 list 查询与 destroy mutation;read action 开 offset 分页。AshGraphql 按字段类型自动派生 filter/sort 输入类型。

### 2. gridMeta 查询

显式白名单 map(如 `"sysUsers" => SynieCore.Accounts.User`),白名单外的资源名直接返回 GraphQL 错误(信任边界,不做动态模块查找)。

**columns**:用 `Ash.Resource.Info.public_attributes/1` 反射,每列返回:

- `name`:camelCase 字段名
- `type`:string / integer / decimal / boolean / date / datetime / enum
- `label`:attribute 的 `description`,未写则回退字段名
- `sortable` / `filterable`:布尔
- `enumOptions`:enum 类型的取值列表(含 label)

**capabilities**:字符串枚举列表,取值:

```
create | update | destroy | bulkDestroy | import | export | print | bulkPrint
```

「查」(read)不在能力集里:能看到表格页本身就是 read 权限的体现,由菜单/路由和服务端查询 policy 门控,不是表格内的动作按钮。

权限架构未落地前的 stub:已登录即返回全部能力(当前只有 admin)。**接口即契约**——未来权限系统落地只改 resolver 内部:CRUD 类走 Ash policy 检查(`Ash.can?`),import/export/print 等非 Ash 原生动作走 ACL 权限点(如 `sys_user:export`)。前端不感知这次切换。

## 前端组件

依赖:`@heroui-pro/react`(私有 npm 包,token 在根 `.env`)。

### DataGrid 集成事实(已核对 Pro 文档)

- DataGrid 是纯渲染层:列为 `DataGridColumn<T>[]` 对象数组(非 compound 组件),必填 `data / columns / getRowId / aria-label`。
- 排序:必须传受控 `sortDescriptor` + `onSortChange`,否则组件会在客户端重排当前页。
- 筛选 UI、分页器、工具栏、批量操作条、初次加载态**均不内置**,由封装层组合:批量条用 Pro `ActionBar`(`isOpen={selectionCount > 0}` 浮出),分页用 OSS `Pagination` + `InlineSelect`(每页行数),行内菜单为 `pinned: "end"` 的动作列内放 `Dropdown`,空态用 `renderEmptyState` + Pro `EmptyState`。
- 选择:`selectionMode="multiple"` + 受控 `selectedKeys`;注意 `"all"` 字面量语义是"当前 data 全选",封装层需专门处理该分支。
- 服务端分页每页数据量小,不启用虚拟化(虚拟化要求固定行高,留作未来大页量选项)。

### Props 契约

```tsx
<SynieDataGrid
  resource="sysUsers"            // 与后端白名单同名
  exclude={["hashedPassword"]}   // 可选:排除列
  overrides={{ status: { render: (v, row) => <StatusChip v={v} /> } }}  // 可选:覆盖单列渲染

  // 标准动作的业务回调(按钮显隐由 capabilities 决定,不传回调则该按钮即使有权限也不渲染)
  onCreate={() => ...}                    // create:工具栏「新增」
  onEdit={(row) => ...}                   // update:行内「编辑」
  onImport={(ctx) => ...}                 // import:工具栏「导入」,ctx 含 refetch
  onPrint={(rows) => ...}                 // print/bulkPrint:可选,覆盖默认打印视图

  // 追加自定义动作(在标准动作之外),capability 字段可选,填了则按能力集门控
  bulkActions={[{ key: "disable", label: "批量停用", isDanger: true, capability: "update",
                  onAction: (rows, { refetch }) => ... }]}
  rowActions={[{ key: "resetPwd", label: "重置密码", capability: "update",
                 onAction: (row, { refetch }) => ... }]}
/>
```

### 标准动作矩阵

| 能力 | UI 位置 | 默认行为 | 覆盖口 |
|---|---|---|---|
| `create` | 工具栏「新增」 | 无(纯回调) | `onCreate` |
| `update` | 行内「编辑」 | 无(纯回调) | `onEdit` |
| `destroy` | 行内「删除」 | **内建**:确认框 → AshGraphql destroy mutation → refetch | — |
| `bulkDestroy` | ActionBar「批量删除」 | **内建**:确认框(含条数)→ 逐条 destroy → refetch | — |
| `export` | 工具栏「导出」 | **内建**:按当前筛选+排序循环拉取全部页 → 前端生成 CSV(UTF-8 BOM,Excel 兼容)下载 | — |
| `import` | 工具栏「导入」 | 无(纯回调,模板/校验/错误行反馈业务相关) | `onImport` |
| `print` | 行内「打印」 | **内建默认**:该行按列定义渲染打印视图 → `window.print()` | `onPrint` |
| `bulkPrint` | ActionBar「批量打印」 | 同上,选中行渲染打印视图 | `onPrint` |

- 内建批量删除为前端逐条 destroy。ponytail: 逐条循环,量大或需事务性时后端加 Ash bulk action 再切。
- 内建导出为前端循环拉页。ponytail: 数据量大(万行级)时改后端流式导出。
- 打印默认视图是兜底;正式单据模板(如打印凭证)通过 `onPrint` 走业务实现。

### 行为

- **排序**:列头点击 → 受控 sortDescriptor → AshGraphql `sort` 变量。
- **筛选**:封装层自建列头筛选(HeroUI Popover),按列类型出控件——string→包含输入框、enum→多选、boolean→开关、date/number→范围;顶部 `SearchField` 做跨列快捷搜索(映射到可筛选 string 列的 or-contains)。
- **分页**:offset 分页,`Pagination` + 每页行数选择。
- **动作执行上下文**:所有回调收到 `{ refetch }`。

### 类型边界(本方案唯一的代价)

行查询是运行时拼的,codegen 不覆盖:grid 内部行数据为 `Record<string, unknown>`,`overrides.render` 与动作回调的行入参由调用方断言。表格之外的页面代码照旧走 codegen 强类型。

## 错误处理

- gridMeta 或行查询失败 → 表格错误态(封装层自建,DataGrid 无错误态 prop)。
- 白名单外资源名 → 明确 GraphQL 错误,不静默。
- 内建 destroy 失败 → 错误提示,不 refetch;批量删除部分失败 → 汇总提示成功/失败条数后 refetch。

## 测试

- 后端 ExUnit:gridMeta resolver(sys_user 返回预期列与 stub 能力集);一条带 filter + sort + 分页的 GraphQL 查询;一条 destroy mutation。核心逻辑都在后端。
- 前端:试点页手动验收。

## 试点

`sys_user` 列表页(用户管理),验证排序/筛选/分页/标准动作(权限 stub 全开)全链路。

## 实现前置条件(启动时逐项核对)

1. master 上未提交的账户/登录工作先提交(试点依赖 sys_user 资源与登录)。
2. 系统至少再有 1-2 张真实业务表(避免为单表过度设计)。
3. 权限架构方向确定(不必完成——capabilities 接口已隔离,但 ACL 权限点命名规范最好先定,如 `资源:动作`)。
4. 安装 `@heroui-pro/react`(token 在根 `.env`);heroui-pro MCP 已可用(2026-07-07 已接通)。
