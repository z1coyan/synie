# SynieDataGrid 设计

日期:2026-07-07(v4 @ 2026-07-08:对齐已落地的权限系统与 HeroUI v3,前置基本满足)
状态:待用户确认后可启动实现计划

## 目标

封装一个 `SynieDataGrid` React 组件:传入 Ash 资源名(即 GraphQL 查询名),自动渲染重型业务表格——每列服务端排序/筛选、offset 分页、行选择;并根据**当前用户对该资源的权限**自动配置标准动作(新增、编辑、删除、打印、批量删除、批量导入、批量导出、批量打印)以及资源自声明的扩展工作流动作(审核、反审核、关闭等)。

## 非目标

- 增/改表单不泛化:grid 只负责按权限显示按钮,表单由页面在回调里提供。
- grid 只对「无表单入参、仅吃记录 id」的动作内建 mutation(删除与扩展工作流动作);导入、打印及任何需要表单的动作由回调承接。
- 不做列级权限(字段脱敏/隐藏等后续再议)。
- 不为此引入前端测试框架。
- 跨页全选:v1 全选 = 当前页全选(DataGrid `selectedKeys: "all"` 的原生语义),批量动作作用于当前页选中行。
- `batch_update` 权限动作码存在于默认动作集,但无通用 UI 形态,grid 不给标准按钮;需要时作为自定义动作的 `capability` 门控使用。

## 架构与数据流

```
Ash 资源 (声明 permission_prefix/0 + permission_actions/0,挂 policy 三段式样板)
  ├─ 域 graphql 块暴露 list 查询(开 offset 分页)与 mutations
  │    └─ AshGraphql 自动派生 filter / sort / 分页参数(零手写筛选代码)
  └─ gridMeta(resource: String!) 查询,返回:
       ├─ columns: 反射资源属性 → 列定义
       ├─ capabilities: actor 在该资源上拥有的权限动作码
       └─ extendedActions: 资源自声明的工作流动作描述符
             ↓
<SynieDataGrid resource="sysRoles" onCreate={...} onEdit={...} />
  1. 查 gridMeta → 列定义 + 能力集 + 扩展动作
  2. 据列定义动态拼行查询字符串;据能力集装配标准/扩展动作
  3. 排序/筛选/分页状态 → AshGraphql 变量,全部服务端执行
```

## 后端

### 1. 资源暴露

上表格的资源在域的 `graphql do` 块暴露 list 查询与所需 mutations;对应 read action 开启 **offset 分页**。注意:现有系统资源的 list 查询是 `paginate_with: nil`(扁平列表),上表格前需为该资源开分页(或另加一个分页版查询,保持旧调用不破坏)。

### 2. gridMeta 查询

显式白名单 map(如 `"sysRoles" => SynieCore.Authz.Role`),白名单外的资源名直接返回 GraphQL 错误(信任边界;`Authz.Registry` + AshGraphql 反射理论上可自动派生映射,实现时哪个简单用哪个,白名单为默认)。

**columns**:用 `Ash.Resource.Info.public_attributes/1` 反射,每列返回:

- `name`:camelCase 字段名
- `type`:string / integer / decimal / boolean / date / datetime / enum
- `label`:attribute 的 `description`,未写则回退字段名
- `sortable` / `filterable`:布尔
- `enumOptions`:enum 类型的取值列表(含 label)

**capabilities**:**直接采用权限系统的动作码**(不另造一套词汇)。resolver 对资源 `permission_actions/0` 声明的每个动作码算 `Authz.has_permission?(actor, "#{prefix}:#{action}")`,返回通过的码列表:

- 标准码(默认动作集,grid 内置其 UI 与默认行为):`create | update | delete | batch_delete | import | export | print | batch_print`
- 扩展码(资源在 `permission_actions/0` 里追加的工作流动作):`audit | unaudit | close | ……`,开放集合

「查」(read)不返回给 grid:能看到表格页本身就是 read 权限的体现,由菜单/路由和服务端查询 policy 门控。前端如需全局权限(菜单门控)另用现成的 `myPermissions` 查询,与 gridMeta 互不依赖。

**extendedActions**:扩展动作的描述符列表(grid 只渲染 key ∈ capabilities 的项):

```
{ key: "audit", label: "审核", scope: "row" | "bulk" | "both",
  mutation: "auditSysOrder",   # AshGraphql mutation 字段名
  isDanger: false }
```

来源:资源模块自声明类函数(跟随 `permission_prefix/0`/`permission_actions/0` 的既有惯例,如 `grid_actions/0`)。label/scope/isDanger 反射不出来,声明是必要的,也就几行。动作本体是资源的自定义 update action,经域 graphql 块暴露成 mutation;权限点因其在 `permission_actions/0` 中而自动进入 `Registry` 目录、支持通配授权。

### 3. 权限校验的双层语义

capabilities 只管前端按钮显隐;真正的权限校验永远在服务端 Ash policy(`HasPermission` check,fail-closed)。注意动作码映射:policy 侧 `:destroy → "delete"`,gridMeta 与前端一律使用权限动作码 `delete`,由 grid 内部映射到 GraphQL 的 destroy mutation。

## 前端组件

依赖:`@heroui-pro/react`(已安装,beta,CSS 已引入)。现有手写 `gqlFetch` 客户端天然适配运行时拼查询,无需引入新 GraphQL 客户端。

### DataGrid 集成事实(已核对 Pro 文档)

- DataGrid 是纯渲染层:列为 `DataGridColumn<T>[]` 对象数组(非 compound 组件),必填 `data / columns / getRowId / aria-label`。
- 排序:必须传受控 `sortDescriptor` + `onSortChange`,否则组件会在客户端重排当前页。
- 筛选 UI、分页器、工具栏、批量操作条、初次加载态**均不内置**,由封装层组合:批量条用 Pro `ActionBar`(`isOpen={selectionCount > 0}` 浮出),分页用 OSS `Pagination` + `InlineSelect`(每页行数),行内菜单为 `pinned: "end"` 的动作列内放 `Dropdown`,空态用 `renderEmptyState` + Pro `EmptyState`。
- 选择:`selectionMode="multiple"` + 受控 `selectedKeys`;注意 `"all"` 字面量语义是"当前 data 全选",封装层需专门处理该分支。
- 服务端分页每页数据量小,不启用虚拟化(虚拟化要求固定行高,留作未来大页量选项)。

### Props 契约

```tsx
<SynieDataGrid
  resource="sysRoles"            // 与后端白名单同名
  exclude={["internalNote"]}     // 可选:排除列
  overrides={{ enabled: { render: (v, row) => <EnabledChip v={v} /> } }}  // 可选:覆盖单列渲染

  // 标准动作的业务回调(按钮显隐由 capabilities 决定,不传回调则该按钮即使有权限也不渲染)
  onCreate={() => ...}                    // create:工具栏「新增」
  onEdit={(row) => ...}                   // update:行内「编辑」
  onImport={(ctx) => ...}                 // import:工具栏「导入」,ctx 含 refetch
  onPrint={(rows) => ...}                 // print/batch_print:可选,覆盖默认打印视图

  // 扩展动作(审核/关闭等)默认内建执行;需要表单(如审核意见)时按 key 覆盖
  actionHandlers={{ audit: (rows, { refetch }) => ... }}

  // 追加自定义动作(在标准动作之外),capability 字段可选,填了则按能力集门控
  bulkActions={[{ key: "disable", label: "批量停用", isDanger: true, capability: "batch_update",
                  onAction: (rows, { refetch }) => ... }]}
  rowActions={[{ key: "resetPwd", label: "重置密码", capability: "update",
                 onAction: (row, { refetch }) => ... }]}
/>
```

### 标准动作矩阵

| 权限动作码 | UI 位置 | 默认行为 | 覆盖口 |
|---|---|---|---|
| `create` | 工具栏「新增」 | 无(纯回调) | `onCreate` |
| `update` | 行内「编辑」 | 无(纯回调) | `onEdit` |
| `delete` | 行内「删除」 | **内建**:确认框 → AshGraphql destroy mutation → refetch | — |
| `batch_delete` | ActionBar「批量删除」 | **内建**:确认框(含条数)→ 逐条 destroy → refetch | — |
| `export` | 工具栏「导出」 | **内建**:按当前筛选+排序循环拉取全部页 → 前端生成 CSV(UTF-8 BOM,Excel 兼容)下载 | — |
| `import` | 工具栏「导入」 | 无(纯回调,模板/校验/错误行反馈业务相关) | `onImport` |
| `print` | 行内「打印」 | **内建默认**:该行按列定义渲染打印视图 → `window.print()` | `onPrint` |
| `batch_print` | ActionBar「批量打印」 | 同上,选中行渲染打印视图 | `onPrint` |
| 扩展动作(审核/反审核/关闭…) | 行内菜单及/或 ActionBar(按 `scope`) | **内建**:确认框 → 描述符声明的 mutation(仅记录 id 入参,批量则逐条)→ refetch | `actionHandlers[key]` |

- 内建批量执行为前端逐条 mutation。ponytail: 逐条循环,量大或需事务性时后端加 Ash bulk action 再切。
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

- gridMeta 或行查询失败 → 表格错误态(封装层自建,DataGrid 无错误态 prop);操作类失败按 web 规范用 Toast 反馈。
- 白名单外资源名 → 明确 GraphQL 错误,不静默。
- 内建 mutation(delete/扩展动作)失败 → Toast 错误提示,不 refetch;批量执行部分失败 → 汇总提示成功/失败条数后 refetch。服务端 policy 拒绝(权限在会话中途被收走)同样落入此错误路径。

## 测试

- 后端 ExUnit:gridMeta resolver——列反射正确;capabilities 随授权变化(无权限 actor 得空集、授权后得对应码、super_admin 全开);白名单外报错;extendedActions 声明的 mutation 字段存在于 schema、其 key 存在于该资源 `permission_actions/0`(双一致性校验)。另:一条带 filter + sort + 分页的 list 查询;一条 destroy mutation 走 policy 拒绝/通过两分支。
- 前端:试点页手动验收。

## 试点

**`Authz.Role` 角色管理页**(`/system/roles`,菜单项已存在):policy/CRUD mutation/list 查询齐备,列含 string(code/name)+ boolean(enabled)+ 时间戳,能覆盖排序/筛选/分页/标准动作全链路。
说明:`sys_user` 未挂 policy(权限终审跟进项),上表格前先补;`Org.Company` 树形,DataGrid 树模式是客户端心智,留二期。

## 启动实现前的剩余事项

1. 为 `Authz.Role` 的 list 查询开 offset 分页(现为 `paginate_with: nil`)。
2. 试点页无扩展动作(角色无审核流),扩展动作机制以 ExUnit + 测试域资源(照 `test_domain.ex` 样板)验证,首个真实使用者出现在未来业务单据表。
3. ~~web 升 HeroUI v3~~、~~权限架构落地~~、~~Pro 包安装~~——均已满足(2026-07-08 核对)。
