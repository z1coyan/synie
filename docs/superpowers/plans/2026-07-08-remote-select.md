# RemoteSelect 外键控件族实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 四个外键控件(RemoteSelect / RemoteMultiSelect / RemoteDialogSelect / RemoteDialogMultiSelect)+ 后端 GridMeta 反射 belongs_to,打通 SynieDataGrid(单元格 label + fk 筛选)与 SynieRecordDrawer(三态表单)的外键能力,公司管理页试点。

**Architecture:** 后端 GridMeta 列元数据增加 `ref {resource, relation, labelField}`(反射 belongs_to,按 actor 目标资源 read 权限 fail-closed 裁剪);前端非 dialog 控件统一 Autocomplete 基座(单选/多选,受控远程搜索 + 无限滚动),dialog 控件 = Modal 内嵌 SynieDataGrid picker 模式;值语义统一 id(单 `string|null` / 多 `string[]`)。设计 spec:`docs/superpowers/specs/2026-07-08-remote-select-design.md`。

**Tech Stack:** Elixir/Ash/AshGraphql(后端反射)+ React 19 + `@heroui/react` v3(Autocomplete/Modal/TagGroup)+ `@heroui-pro/react`(DataGrid)+ `@tanstack/react-query`(useInfiniteQuery)+ 手写 `gqlFetch`。前端纯函数用 bun 直跑 checks 文件,后端 ExUnit。

## Global Constraints

- 项目第一语言中文,所有 UI 文案、注释用中文。
- 桌面/移动断点统一 `lg`(1024px)。
- 表单/筛选控件一律 HeroUI(Pro) 现成组件;HeroUI v3:子组件点号、`onPress` 不用 `onClick`、无 Provider、Select/Autocomplete 受控用 `value`/`onChange`(ComboBox 是 `selectedKey`,本轮不用 ComboBox)。
- HeroUI 组件 props 报类型错时,用 `heroui-pro` MCP 的 `get_component_docs` 查(autocomplete/tag-group/modal/list-box/search-field),按官方 anatomy 修正,不要自造 props。已核查的关键点:Autocomplete 支持 `selectionMode="multiple"`、`Autocomplete.Value` 接受任意 ReactNode、`Autocomplete.Filter` 受控 `inputValue`/`onInputChange`/`filter`、必须加 `allowsEmptyCollection`(空列表弹层不自动关)、`ListBox.Item` 必填 `textValue`、`ListBoxLoadMoreItem` 做无限滚动、Modal `size="lg"` 仅 512px 需 className 覆盖宽度。
- 手拼 GraphQL 字面量的值必须过白名单/转义:uuid 过 `UUID_RE`,搜索词过 `JSON.stringify`(enum 白名单先例)。
- 非幂等请求 Toast 反馈与错误处理(web/CLAUDE.md 守则)。
- 前端闸门:`bunx tsc --noEmit` + 三个 checks 文件全绿;后端闸门:`mix test` 全绿。
- mix 不在非交互 shell PATH:`export PATH="$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$HOME/.elixir-install/installs/otp/28.4/bin:$PATH"`;Postgres 在 synie-pg 容器 5440(dev/test config 已默认)。
- 工作目录:执行时用 superpowers:using-git-worktrees 建 worktree(下称 `$WT`),然后软链依赖(勿在 worktree 重新 install;期间勿在主 checkout 同时跑 mix 编译):

```bash
ln -sfn /home/zyan/code/synie/web/node_modules "$WT/web/node_modules"
ln -sfn /home/zyan/code/synie/backend/deps "$WT/backend/deps"
ln -sfn /home/zyan/code/synie/backend/_build "$WT/backend/_build"
```

---

### Task 1: 后端 GridMeta ref 反射 + 公司资源接入(TDD)

**Files:**
- Modify: `backend/apps/synie_web/lib/synie_web/grid_meta.ex`
- Modify: `backend/apps/synie_web/lib/synie_web/schema.ex`(grid_column_ref object)
- Modify: `backend/apps/synie_core/lib/synie_core/org/company.ex`(中文 description)
- Modify: `backend/apps/synie_core/lib/synie_core.ex`(bas_companies 改 offset 分页)
- Test: `backend/apps/synie_web/test/synie_web/schema_grid_test.exs`

**Interfaces:**
- Produces(Task 2 起前端依赖):gridMeta 列新增 `ref { resource relation labelField } | null`;fk 列 `type: "fk"`、`sortable: false`、`filterable: true`;白名单新增 `"basCompanies" => SynieCore.Org.Company`;`basCompanies` 支持 `limit/offset/count/results` 与 `{parentId: {in: [...]}}`、`{id: {in: [...]}}` 筛选、`parent { id name }` join。
- 显示字段约定:目标资源可实现 `display_field/0` 返回 atom 覆盖,默认 `:name`。

- [ ] **Step 1: 写失败的测试**

`schema_grid_test.exs` 的 `@meta_query` 中 `columns` 一行替换为:

```elixir
      columns { name type label sortable filterable enumOptions { value label } ref { resource relation labelField } }
```

模块级(describe 外,`defp roles!` 之后)加公司夹具:

```elixir
  defp company!(code, name, parent_id \\ nil) do
    SynieCore.Org.Company
    |> Ash.Changeset.for_create(:create, %{code: code, name: name, short_name: name, parent_id: parent_id})
    |> Ash.create!(authorize?: false)
  end
```

文件末尾(最后一个 describe 之后)追加:

```elixir
  describe "gridMeta 外键 ref" do
    test "有目标 read 权限:parentId 为 fk 列并携带 ref" do
      actor = Authz.build_actor(user_with!(["org.company:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "basCompanies")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{
               "type" => "fk",
               "label" => "上级公司",
               "sortable" => false,
               "filterable" => true,
               "ref" => %{"resource" => "basCompanies", "relation" => "parent", "labelField" => "name"}
             } = by_name["parentId"]
    end

    test "无目标 read 权限:退化为 uuid 列(string/不可筛/无 ref)" do
      actor = Authz.build_actor(user_with!(["sys.role:read"]))
      assert %{data: %{"gridMeta" => meta}} = run_meta!(actor, "basCompanies")
      by_name = Map.new(meta["columns"], &{&1["name"], &1})

      assert %{"type" => "string", "filterable" => false, "ref" => nil} = by_name["parentId"]
    end

    test "无 belongs_to 的资源所有列 ref 为空" do
      assert %{data: %{"gridMeta" => meta}} = run_meta!(super_actor())
      assert Enum.all?(meta["columns"], &(&1["ref"] == nil))
    end
  end

  describe "basCompanies 行查询" do
    test "offset 分页 + parent join + parentId/id in 筛选" do
      actor = Authz.build_actor(user_with!(["org.company:read"]))
      parent = company!("AA", "集团总部")
      _child = company!("AB", "华东子公司", parent.id)
      _other = company!("AC", "独立公司")

      result =
        run!(
          ~s|query { basCompanies(limit: 10, offset: 0, filter: {parentId: {in: ["#{parent.id}"]}}) { count results { id name parent { id name } } } }|,
          actor
        )

      assert %{data: %{"basCompanies" => %{"count" => 1, "results" => [row]}}} = result
      assert row["name"] == "华东子公司"
      assert row["parent"]["name"] == "集团总部"

      by_id =
        run!(
          ~s|query { basCompanies(filter: {id: {in: ["#{parent.id}"]}}) { results { id name } } }|,
          actor
        )

      assert %{data: %{"basCompanies" => %{"results" => [%{"name" => "集团总部"}]}}} = by_id
    end
  end
```

- [ ] **Step 2: 跑测试确认失败**

```bash
export PATH="$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$HOME/.elixir-install/installs/otp/28.4/bin:$PATH"
cd "$WT/backend" && mix test apps/synie_web/test/synie_web/schema_grid_test.exs
```

Expected: FAIL——`ref` 字段不存在于 :grid_column(GraphQL 校验错),或 `basCompanies` 白名单外报错。

- [ ] **Step 3: 实现**

`schema.ex`:在 `object :grid_column do` 之前加:

```elixir
  object :grid_column_ref do
    field :resource, non_null(:string)
    field :relation, non_null(:string)
    field :label_field, non_null(:string)
  end
```

`object :grid_column do` 内 `enum_options` 之后加:

```elixir
    field :ref, :grid_column_ref
```

`grid_meta.ex`:白名单改为:

```elixir
  @resources %{
    "sysRoles" => SynieCore.Authz.Role,
    "basCompanies" => SynieCore.Org.Company
  }
```

`build/2` 改为(fk 反射按 actor 裁剪,故 refs 在这里算好传下去):

```elixir
  def build(module, actor) do
    refs = fk_refs(module, actor)

    %{
      columns: module |> Ash.Resource.Info.public_attributes() |> Enum.map(&column(&1, refs)),
      capabilities: capabilities(module, actor),
      extended_actions: extended_actions(module),
      destroy_mutation: destroy_mutation(module)
    }
  end
```

`column/1` 替换为 `column/2` + 新增 `fk_refs/2`、`display_field/1`:

```elixir
  defp column(attr, refs) do
    case Map.fetch(refs, attr.name) do
      {:ok, ref} ->
        %{
          name: camelize(attr.name),
          type: "fk",
          # belongs_to 的 FK attribute 一般没有 description,兜底用关系上的 description
          label: attr.description || ref.label || to_string(attr.name),
          # uuid 排序无意义;筛选走 eq/in(不走 contains,见 filterable?/1 注释)
          sortable: false,
          filterable: true,
          enum_options: nil,
          ref: %{resource: ref.resource, relation: ref.relation, label_field: ref.label_field}
        }

      :error ->
        %{
          name: camelize(attr.name),
          type: type_name(attr.type),
          label: attr.description || to_string(attr.name),
          sortable: true,
          filterable: filterable?(attr.type),
          enum_options: enum_options(attr.type),
          ref: nil
        }
    end
  end

  # belongs_to → fk 元数据。fail-closed:目标资源不在白名单、或 actor 无目标资源 read 权限,
  # 都不产出 ref,该列退化为普通 uuid 列(string/不可筛),前端表单退 TextField。
  defp fk_refs(module, actor) do
    module_names = Map.new(@resources, fn {name, mod} -> {mod, name} end)

    module
    |> Ash.Resource.Info.relationships()
    |> Enum.filter(&(&1.type == :belongs_to))
    |> Enum.reduce(%{}, fn rel, acc ->
      with {:ok, resource_name} <- Map.fetch(module_names, rel.destination),
           true <- Authz.has_permission?(actor, "#{rel.destination.permission_prefix()}:read") do
        Map.put(acc, rel.source_attribute, %{
          resource: resource_name,
          relation: camelize(rel.name),
          label_field: camelize(display_field(rel.destination)),
          label: rel.description
        })
      else
        _ -> acc
      end
    end)
  end

  # 显示字段约定:资源实现 display_field/0 覆盖,默认 :name
  defp display_field(module) do
    if function_exported?(module, :display_field, 0), do: module.display_field(), else: :name
  end
```

`company.ex`:attributes 加中文 label、关系加 description(GridMeta 列标签来源):

```elixir
    attribute :code, :string do
      allow_nil? false
      public? true
      constraints match: ~r/^[A-Za-z]{2}$/
      description "公司编号"
    end

    attribute :name, :string do
      allow_nil? false
      public? true
      constraints max_length: 128
      description "公司名称"
    end

    attribute :short_name, :string do
      allow_nil? false
      public? true
      constraints max_length: 32
      description "公司简称"
    end
```

```elixir
    belongs_to :parent, __MODULE__ do
      public? true
      attribute_public? true
      attribute_writable? true
      description "上级公司"
    end
```

`synie_core.ex` queries 里 bas_companies 一行改为(前端无存量调用方,改分页形状安全):

```elixir
      list SynieCore.Org.Company, :bas_companies, :read, paginate_with: :offset
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

```bash
cd "$WT/backend" && mix test apps/synie_web/test/synie_web/schema_grid_test.exs && mix test
```

Expected: 全绿(既有 gridMeta 测试断言的列结构不含 ref 字段值,用的是模式匹配,不受新增键影响)。

- [ ] **Step 5: Commit**

```bash
cd "$WT" && git add backend/ && git commit -m "feat: GridMeta 反射 belongs_to 外键——ref 元数据+权限 fail-closed 裁剪,公司资源接入表格"
```

---

### Task 2: 前端 fk 类型/查询/格式化层(TDD)

**Files:**
- Modify: `web/app/components/synie-data-grid/types.ts`
- Modify: `web/app/components/synie-data-grid/query.ts`
- Modify: `web/app/components/synie-data-grid/format.ts`
- Modify: `web/app/components/synie-data-grid/meta.ts`
- Modify: `web/app/components/synie-data-grid/csv.ts`、`print.ts`(cellText 传 row)
- Modify: `web/app/components/synie-data-grid/filter-popover.tsx`(filterSummary fk 分支,保持 union 穷尽)
- Modify: `web/app/components/synie-data-grid/grid-checks.ts`、`web/app/components/synie-record-drawer/record-drawer-checks.ts`(构造处补 ref)

**Interfaces:**
- Produces(Task 3–8 依赖,签名以此为准):
  - `type GridColumnType = ... | 'fk'`
  - `interface GridColumnRef { resource: string; relation: string; labelField: string }`
  - `GridColumnMeta.ref: GridColumnRef | null`
  - `ColumnFilter` 新成员 `{ kind: 'fk'; values: string[]; labels: string[] }`(labels 与 values 对齐,chip 摘要用)
  - `query.ts` 导出 `UUID_RE: RegExp`
  - `cellText(col, value, row?)`:fk 列读 `row[ref.relation][ref.labelField]`,join 缺失退回截断 id
  - `buildRowQuery` 对有 ref 的列追加 `relation { id labelField }` join

- [ ] **Step 1: 改类型(先让 tsc 指出所有波及点)**

`types.ts`:

```ts
export type GridColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime' | 'enum' | 'fk'
```

`GridEnumOption` 之后加:

```ts
export interface GridColumnRef {
  resource: string
  relation: string
  labelField: string
}
```

`GridColumnMeta` 加字段:

```ts
  ref: GridColumnRef | null
```

`ColumnFilter` union 追加一行:

```ts
  | { kind: 'fk'; values: string[]; labels: string[] }
```

- [ ] **Step 2: 写失败的自检**

`grid-checks.ts`:顶部 `cols`、`extraCols`、`dateCols` 的每个字面量补 `ref: null`;文件尾部 `console.log` 之前追加:

```ts
// —— fk 筛选(uuid 白名单)与行查询 join ——
const uuid1 = '11111111-1111-1111-1111-111111111111'
const fkCol: GridColumnMeta = {
  name: 'parentId',
  type: 'fk',
  label: '上级公司',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: { resource: 'basCompanies', relation: 'parent', labelField: 'name' },
}
eq(
  buildFilterLiteral({ parentId: { kind: 'fk', values: [uuid1, 'DROP TABLE'], labels: ['集团'] } }, '', [fkCol]),
  `{parentId: {in: ["${uuid1}"]}}`,
  'fk 筛选:合法 uuid 进 in,非法串剔除'
)
eq(buildFilterLiteral({ parentId: { kind: 'fk', values: ['nope'], labels: [] } }, '', [fkCol]), null, 'fk 全非法为 null')
eq(
  buildRowQuery('basCompanies', [fkCol], { limit: 10, offset: 0, sortLiteral: null, filterLiteral: null }),
  'query { basCompanies(limit: 10, offset: 0) { count results { id parentId parent { id name } } } }',
  'fk 行查询带 join'
)
const fkRow = { id: 'x', parentId: uuid1, parent: { id: uuid1, name: '集团总部' } } as unknown as Row
eq(cellText(fkCol, uuid1, fkRow), '集团总部', 'fk cellText 读 join label')
eq(cellText(fkCol, uuid1, { id: 'x', parent: null } as unknown as Row), '11111111', 'join 缺失退回截断 id')
eq(cellText(fkCol, null, { id: 'x' } as unknown as Row), '', 'fk 空值为空串')
```

`record-drawer-checks.ts`:`col` 辅助函数返回对象补 `ref: null`。

- [ ] **Step 3: 跑自检确认失败**

```bash
cd "$WT/web" && bun app/components/synie-data-grid/grid-checks.ts
```

Expected: FAIL(fk 筛选返回 undefined / 行查询无 join)。

- [ ] **Step 4: 实现**

`query.ts`:文件顶部加:

```ts
/** 手拼查询字面量的 uuid 白名单(fk 筛选/回显反查共用):非法串一律剔除,防注入 */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
```

`columnClause` 的 switch 加分支(`case 'enum'` 之后):

```ts
    case 'fk': {
      const ids = filter.values.filter((v) => UUID_RE.test(v))
      return ids.length > 0 ? `{${name}: {in: [${ids.map(str).join(', ')}]}}` : null
    }
```

`buildRowQuery` 的 fields 拼装改为:

```ts
  const names = columns.map((c) => c.name)
  const scalar = names.includes('id') ? names : ['id', ...names]
  // fk 列带 join:relation { id labelField },单元格/详情显示 label 零额外请求
  const joins = columns.filter((c) => c.ref).map((c) => `${c.ref!.relation} { id ${c.ref!.labelField} }`)
  const fields = [...scalar, ...joins].join(' ')
```

`format.ts` 整文件替换:

```ts
import type { GridColumnMeta, Row } from './types'

/** 共享单元格文本格式化:表格默认渲染、CSV 导出、打印视图三条路径保持一致 */
export function cellText(col: GridColumnMeta, value: unknown, row?: Row): string {
  if (col.type === 'fk' && col.ref) {
    const rel = row?.[col.ref.relation] as Record<string, unknown> | null | undefined
    if (rel && rel[col.ref.labelField] != null) return String(rel[col.ref.labelField])
    // join 缺失(权限裁剪后的旧数据等):退回截断 id,不报错
    return value == null || value === '' ? '' : String(value).slice(0, 8)
  }
  if (value == null || value === '') return ''
  if (col.type === 'boolean') return value ? '是' : '否'
  if (col.type === 'datetime') return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
  if (col.type === 'enum') return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
  return String(value)
}
```

`csv.ts` 的 `toCsv`:format 参数与 cell 调用传 row:

```ts
  format?: (col: C, value: unknown, row: Row) => string
```

```ts
  const cell = (col: C, value: unknown, row: Row) => escape(format ? format(col, value, row) : value)
  const header = columns.map((c) => escape(c.label)).join(',')
  const lines = rows.map((r) => columns.map((c) => cell(c, r[c.name], r)).join(','))
```

`print.ts` 第 16 行 cellText 调用改为 `cellText(c, r[c.name], r)`。

`meta.ts` 的 GRID_META_QUERY columns 行改为:

```ts
      columns { name type label sortable filterable enumOptions { value label } ref { resource relation labelField } }
```

`filter-popover.tsx` 的 `filterSummary` switch 加分支(保持 union 穷尽,fk 筛选 UI 在 Task 5):

```ts
    case 'fk':
      return f.labels.join('、')
```

- [ ] **Step 5: 跑自检 + tsc**

```bash
cd "$WT/web" && bun app/components/synie-data-grid/grid-checks.ts \
  && bun app/components/synie-record-drawer/record-drawer-checks.ts && bunx tsc --noEmit
```

Expected: 两个 checks ok,tsc 无错误(若 SynieDataGrid.tsx/SynieRecordDrawer.tsx 因 cellText 签名报错,按新签名补 row 实参)。

- [ ] **Step 6: Commit**

```bash
cd "$WT" && git add web/ && git commit -m "feat: 前端 fk 列类型与查询层——ref 元数据/uuid 白名单 in 筛选/行查询 join/cellText 读 label"
```

---

### Task 3: synie-remote-select 查询纯函数 + hooks(TDD)

**Files:**
- Create: `web/app/components/synie-remote-select/remote-query.ts`
- Create: `web/app/components/synie-remote-select/use-remote.ts`
- Test: `web/app/components/synie-remote-select/remote-select-checks.ts`

**Interfaces:**
- Consumes: `UUID_RE`、`toSortField`(`../synie-data-grid/query`);`GridColumnRef`、`Row`(`../synie-data-grid/types`)
- Produces(Task 4–8 依赖):
  - `interface RemoteSourceConfig { resource: string; labelField?: string; searchFields?: string[]; filter?: string; fields?: string[]; pageSize?: number; renderItem?: (row: Row) => ReactNode; renderValue?: (row: Row) => ReactNode }`
  - `interface ResolvedSource { resource: string; labelField: string; searchFields: string[]; filter: string | null; fields: string[]; pageSize: number }`
  - `resolveSource(cfg: Partial<RemoteSourceConfig>, ref?: GridColumnRef | null): ResolvedSource | null`(resource 均缺时 null)
  - `buildOptionsQuery(src, search, offset): string` / `buildByIdQuery(src, ids): string | null`
  - `optionLabel(src, row): string`(label 缺失退截断 id)
  - `useRemoteOptions(src: ResolvedSource | null, search: string, enabled: boolean)`(useInfiniteQuery,页结构 `{count, results}`)
  - `useRemoteRecords(src: ResolvedSource | null, ids: string[])`(id 批量反查,data 为 `Row[]`)

- [ ] **Step 1: 写失败的自检**

创建 `remote-select-checks.ts`:

```ts
// bun app/components/synie-remote-select/remote-select-checks.ts 可直接运行的纯函数自检
import { buildByIdQuery, buildOptionsQuery, optionLabel, resolveSource } from './remote-query'
import type { Row } from '../synie-data-grid/types'

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

const ref = { resource: 'basCompanies', relation: 'parent', labelField: 'name' }

// —— resolveSource:ref 提供默认,config 覆盖;都无 resource 为 null ——
eq(resolveSource({}, ref), {
  resource: 'basCompanies',
  labelField: 'name',
  searchFields: ['name'],
  filter: null,
  fields: [],
  pageSize: 20,
}, 'ref 默认值')
eq(
  resolveSource({ resource: 'sysUsers', labelField: 'username', searchFields: ['username', 'name'], filter: '{enabled: {eq: true}}', fields: ['name'], pageSize: 50 }, ref)!.resource,
  'sysUsers',
  'config 覆盖 ref'
)
eq(resolveSource({ searchFields: [] }, ref)!.searchFields, ['name'], '空 searchFields 回落 labelField')
eq(resolveSource({}), null, '无 resource 为 null')

const src = resolveSource({ searchFields: ['name', 'code'], filter: '{enabled: {eq: true}}' }, ref)!

// —— buildOptionsQuery:固定过滤 and 搜索 or;搜索词 JSON 转义;labelField 升序 ——
eq(
  buildOptionsQuery(src, '', 0),
  'query { basCompanies(limit: 20, offset: 0, sort: [{field: NAME, order: ASC}], filter: {enabled: {eq: true}}) { count results { id name } } }',
  '无搜索词只有固定过滤'
)
eq(
  buildOptionsQuery(src, ' 华东"x" ', 20),
  `query { basCompanies(limit: 20, offset: 20, sort: [{field: NAME, order: ASC}], filter: {and: [{enabled: {eq: true}}, {or: [{name: {contains: ${JSON.stringify('华东"x"')}}}, {code: {contains: ${JSON.stringify('华东"x"')}}}]}]}) { count results { id name } } }`,
  '搜索词 trim+转义,多字段 or'
)
eq(
  buildOptionsQuery(resolveSource({}, ref)!, 'a', 0),
  'query { basCompanies(limit: 20, offset: 0, sort: [{field: NAME, order: ASC}], filter: {name: {contains: "a"}}) { count results { id name } } }',
  '单条件不包 and/or'
)

// —— buildByIdQuery:去重 + uuid 白名单;全非法为 null ——
const u1 = '11111111-1111-1111-1111-111111111111'
const u2 = '22222222-2222-2222-2222-222222222222'
eq(
  buildByIdQuery(resolveSource({}, ref)!, [u1, u2, u1, 'DROP']),
  `query { basCompanies(limit: 2, offset: 0, filter: {id: {in: ["${u1}", "${u2}"]}}) { count results { id name } } }`,
  '回显反查批量 in'
)
eq(buildByIdQuery(resolveSource({}, ref)!, ['nope']), null, '全非法为 null')
eq(buildByIdQuery(resolveSource({ fields: ['code', 'name'] }, ref)!, [u1])!.includes('{ id name code }'), true, 'fields 去重合并')

// —— optionLabel ——
eq(optionLabel(src, { id: u1, name: '集团总部' } as unknown as Row), '集团总部', 'label 字段')
eq(optionLabel(src, { id: u1, name: null } as unknown as Row), '11111111', 'label 缺失退截断 id')
eq(optionLabel(src, null), '', '空行为空串')

console.log('remote-select-checks ok')
```

- [ ] **Step 2: 跑自检确认失败**

```bash
cd "$WT/web" && bun app/components/synie-remote-select/remote-select-checks.ts
```

Expected: FAIL——`Cannot find module './remote-query'`。

- [ ] **Step 3: 实现 remote-query.ts**

```ts
import type { ReactNode } from 'react'
import { toSortField, UUID_RE } from '../synie-data-grid/query'
import type { GridColumnRef, Row } from '../synie-data-grid/types'

export interface RemoteSourceConfig {
  /** GridMeta 白名单资源名(即 GraphQL list query 名),如 "basCompanies" */
  resource: string
  /** 显示字段,默认 gridMeta ref.labelField,再兜底 'name' */
  labelField?: string
  /** 远程搜索 contains OR 字段,默认 [labelField] */
  searchFields?: string[]
  /** 固定过滤字面量,如 `{enabled: {eq: true}}` */
  filter?: string
  /** 额外取回字段(renderItem/renderValue 用) */
  fields?: string[]
  pageSize?: number
  /** 下拉项渲染,默认 label 单行 */
  renderItem?: (row: Row) => ReactNode
  /** 选中回填渲染,默认 label 文本/chip */
  renderValue?: (row: Row) => ReactNode
}

export interface ResolvedSource {
  resource: string
  labelField: string
  searchFields: string[]
  filter: string | null
  fields: string[]
  pageSize: number
}

/** gridMeta ref 提供默认,页面 config 覆盖;二者都无 resource 时 null(调用方退化 TextField) */
export function resolveSource(cfg: Partial<RemoteSourceConfig>, ref?: GridColumnRef | null): ResolvedSource | null {
  const resource = cfg.resource ?? ref?.resource
  if (!resource) return null
  const labelField = cfg.labelField ?? ref?.labelField ?? 'name'
  return {
    resource,
    labelField,
    searchFields: cfg.searchFields?.length ? cfg.searchFields : [labelField],
    filter: cfg.filter ?? null,
    fields: cfg.fields ?? [],
    pageSize: cfg.pageSize ?? 20,
  }
}

const selectionFields = (src: ResolvedSource): string => [...new Set(['id', src.labelField, ...src.fields])].join(' ')

/** 选项分页查询:labelField 升序稳定排序;搜索词 JSON.stringify 转义后拼 contains OR */
export function buildOptionsQuery(src: ResolvedSource, search: string, offset: number): string {
  const clauses: string[] = []
  if (src.filter) clauses.push(src.filter)
  const s = search.trim()
  if (s) {
    const ors = src.searchFields.map((f) => `{${f}: {contains: ${JSON.stringify(s)}}}`)
    clauses.push(ors.length === 1 ? ors[0] : `{or: [${ors.join(', ')}]}`)
  }
  const args = [`limit: ${src.pageSize}`, `offset: ${offset}`, `sort: [{field: ${toSortField(src.labelField)}, order: ASC}]`]
  if (clauses.length === 1) args.push(`filter: ${clauses[0]}`)
  if (clauses.length > 1) args.push(`filter: {and: [${clauses.join(', ')}]}`)
  return `query { ${src.resource}(${args.join(', ')}) { count results { ${selectionFields(src)} } } }`
}

/** 回显反查:去重 + uuid 白名单,一次 in 批量;全非法/为空返回 null(调用方跳过请求) */
export function buildByIdQuery(src: ResolvedSource, ids: string[]): string | null {
  const valid = [...new Set(ids)].filter((v) => UUID_RE.test(v))
  if (valid.length === 0) return null
  const lit = valid.map((v) => JSON.stringify(v)).join(', ')
  return `query { ${src.resource}(limit: ${valid.length}, offset: 0, filter: {id: {in: [${lit}]}}) { count results { ${selectionFields(src)} } } }`
}

/** 行的显示文本:labelField 值,缺失退截断 id(已删/无权限时不至于空白) */
export function optionLabel(src: ResolvedSource, row: Row | null | undefined): string {
  if (!row) return ''
  const v = row[src.labelField]
  return v == null ? String(row.id).slice(0, 8) : String(v)
}
```

- [ ] **Step 4: 实现 use-remote.ts**

```ts
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import type { Row } from '../synie-data-grid/types'
import { buildByIdQuery, buildOptionsQuery, type ResolvedSource } from './remote-query'

interface PageResult {
  count: number
  results: Row[]
}

/** 选项无限滚动:enabled=弹层打开才发请求;search/filter 进 queryKey 自动重查 */
export function useRemoteOptions(src: ResolvedSource | null, search: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['remoteOptions', src?.resource, src?.filter, src?.searchFields.join('|'), search],
    enabled: enabled && src != null,
    staleTime: 30_000,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      gqlFetch<Record<string, PageResult>>(buildOptionsQuery(src!, search, pageParam)).then((d) => d[src!.resource]),
    getNextPageParam: (last, pages) => {
      // 按实际返回行数推进(csv fetchAllRows 先例:limit 可能被服务端钳制)
      const loaded = pages.reduce((n, p) => n + p.results.length, 0)
      return last.results.length > 0 && loaded < last.count ? loaded : undefined
    },
  })
}

/** id → 行数据批量反查(回显);ids 空/全非法跳过;回显数据不常变,staleTime 放长 */
export function useRemoteRecords(src: ResolvedSource | null, ids: string[]) {
  const query = src ? buildByIdQuery(src, ids) : null
  return useQuery({
    queryKey: ['remoteRecords', src?.resource, [...ids].sort().join(',')],
    enabled: query != null,
    staleTime: 5 * 60_000,
    queryFn: () => gqlFetch<Record<string, PageResult>>(query!).then((d) => d[src!.resource].results),
  })
}
```

- [ ] **Step 5: 跑自检 + tsc + Commit**

```bash
cd "$WT/web" && bun app/components/synie-remote-select/remote-select-checks.ts && bunx tsc --noEmit
cd "$WT" && git add web/app/components/synie-remote-select/ && git commit -m "feat: RemoteSelect 查询纯函数与 hooks——选项无限分页/回显批量反查(bun 自检)"
```

Expected: `remote-select-checks ok`,tsc 无错误。

---

### Task 4: RemoteSelect / RemoteMultiSelect 组件

**Files:**
- Create: `web/app/components/synie-remote-select/options-popover.tsx`(弹层内搜索+列表,单/多选共用)
- Create: `web/app/components/synie-remote-select/RemoteSelect.tsx`
- Create: `web/app/components/synie-remote-select/RemoteMultiSelect.tsx`

**Interfaces:**
- Consumes: Task 3 全部导出;`useDraft`(`../synie-data-grid/use-debounced`);HeroUI `Autocomplete/TagGroup/Tag/ListBox/SearchField/Spinner/Label`
- Produces(Task 5/7/8 依赖):
  - `RemoteSelectProps extends RemoteSourceConfig { value: string | null; onChange: (id: string | null, row: Row | null) => void; label?: string; placeholder?: string; isDisabled?: boolean; isRequired?: boolean; initialRows?: Row[] }`
  - `RemoteMultiSelectProps extends RemoteSourceConfig { value: string[]; onChange: (ids: string[], rows: Row[]) => void; label?; placeholder?; isDisabled?; isRequired?; initialRows?: Row[] }`(onChange 的 rows 只含已知行,缺失 id 的行不凑数)

- [ ] **Step 1: 实现 options-popover.tsx**

```tsx
import type { ReactNode } from 'react'
import { Collection } from 'react-aria-components'
import { Autocomplete, ListBox, ListBoxLoadMoreItem, SearchField, Spinner } from '@heroui/react'
import type { Row } from '../synie-data-grid/types'
import { optionLabel, type ResolvedSource } from './remote-query'
import type { useRemoteOptions } from './use-remote'

/**
 * 弹层内容:受控搜索框 + 选项列表 + 无限滚动,单/多选共用。
 * 搜索框在弹层内(Autocomplete.Filter),filter 直通关掉客户端二次过滤。
 */
export function RemoteOptionsPopover({
  src,
  draft,
  onDraft,
  options,
  renderItem,
}: {
  src: ResolvedSource
  draft: string
  onDraft: (v: string) => void
  options: ReturnType<typeof useRemoteOptions>
  renderItem?: (row: Row) => ReactNode
}) {
  const rows = (options.data?.pages ?? []).flatMap((p) => p.results)
  return (
    <Autocomplete.Popover>
      <Autocomplete.Filter inputValue={draft} onInputChange={onDraft} filter={() => true}>
        {/* 移动端自动聚焦会立刻弹键盘,仅桌面 autoFocus */}
        <SearchField aria-label="搜索" autoFocus={typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches}>
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="输入关键字搜索…" />
            {options.isFetching && !options.isFetchingNextPage ? <Spinner size="sm" /> : <SearchField.ClearButton />}
          </SearchField.Group>
        </SearchField>
      </Autocomplete.Filter>
      <ListBox
        aria-label="选项"
        renderEmptyState={() => (
          <div className="p-3 text-sm text-muted">{options.isPending ? '加载中…' : '无匹配记录'}</div>
        )}
      >
        <Collection items={rows}>
          {(row: Row) => (
            <ListBox.Item id={row.id} textValue={optionLabel(src, row)}>
              {renderItem ? renderItem(row) : optionLabel(src, row)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          )}
        </Collection>
        {options.hasNextPage && (
          <ListBoxLoadMoreItem isLoading={options.isFetchingNextPage} onLoadMore={() => options.fetchNextPage()}>
            <Spinner size="sm" />
          </ListBoxLoadMoreItem>
        )}
      </ListBox>
    </Autocomplete.Popover>
  )
}
```

- [ ] **Step 2: 实现 RemoteSelect.tsx**

```tsx
import { useState } from 'react'
import { Autocomplete, Label } from '@heroui/react'
import { useDraft } from '../synie-data-grid/use-debounced'
import type { Row } from '../synie-data-grid/types'
import { RemoteOptionsPopover } from './options-popover'
import { optionLabel, resolveSource, type RemoteSourceConfig } from './remote-query'
import { useRemoteOptions, useRemoteRecords } from './use-remote'

export interface RemoteSelectProps extends RemoteSourceConfig {
  value: string | null
  onChange: (id: string | null, row: Row | null) => void
  label?: string
  placeholder?: string
  isDisabled?: boolean
  isRequired?: boolean
  /** 已有行数据(表格行 join 等)短路回显反查 */
  initialRows?: Row[]
}

export function RemoteSelect(props: RemoteSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // 草稿即时回显,停稳 300ms 才发请求(useDraft 先例)
  const [draft, setDraft] = useDraft(search, setSearch)
  const options = useRemoteOptions(src, search, open)

  // 回填数据源:initialRows + 已加载选项页 + 反查兜底,后写覆盖前写
  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  for (const r of (options.data?.pages ?? []).flatMap((p) => p.results)) known.set(r.id, r)
  const missing = props.value != null && !known.has(props.value) ? [props.value] : []
  const resolved = useRemoteRecords(src, missing)
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const selectedRow = props.value != null ? (known.get(props.value) ?? null) : null

  return (
    <Autocomplete
      value={props.value}
      onChange={(key) => {
        const id = key == null ? null : String(key)
        props.onChange(id, id ? (known.get(id) ?? null) : null)
      }}
      isDisabled={props.isDisabled}
      isRequired={props.isRequired}
      allowsEmptyCollection
      onOpenChange={setOpen}
    >
      {props.label && <Label>{props.label}</Label>}
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {selectedRow ? (
            (props.renderValue?.(selectedRow) ?? optionLabel(src, selectedRow))
          ) : props.value != null ? (
            // 反查未返回(加载中/已删/无权限):截断 id 顶着,不空白
            String(props.value).slice(0, 8)
          ) : (
            <span className="text-muted">{props.placeholder ?? '请选择…'}</span>
          )}
        </Autocomplete.Value>
        <Autocomplete.ClearButton />
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <RemoteOptionsPopover src={src} draft={draft} onDraft={setDraft} options={options} renderItem={props.renderItem} />
    </Autocomplete>
  )
}
```

- [ ] **Step 3: 实现 RemoteMultiSelect.tsx**

```tsx
import { useState } from 'react'
import { Autocomplete, Label, Tag, TagGroup } from '@heroui/react'
import { useDraft } from '../synie-data-grid/use-debounced'
import type { Row } from '../synie-data-grid/types'
import { RemoteOptionsPopover } from './options-popover'
import { optionLabel, resolveSource, type RemoteSourceConfig } from './remote-query'
import { useRemoteOptions, useRemoteRecords } from './use-remote'

export interface RemoteMultiSelectProps extends RemoteSourceConfig {
  value: string[]
  /** rows 只含已知行数据(缺失 id 不凑数),labels 兜底由调用方截断 id */
  onChange: (ids: string[], rows: Row[]) => void
  label?: string
  placeholder?: string
  isDisabled?: boolean
  isRequired?: boolean
  initialRows?: Row[]
}

export function RemoteMultiSelect(props: RemoteMultiSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useDraft(search, setSearch)
  const options = useRemoteOptions(src, search, open)

  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  for (const r of (options.data?.pages ?? []).flatMap((p) => p.results)) known.set(r.id, r)
  const resolved = useRemoteRecords(src, props.value.filter((id) => !known.has(id)))
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const rowsFor = (ids: string[]) => ids.map((id) => known.get(id)).filter((r): r is Row => r != null)
  const emit = (ids: string[]) => props.onChange(ids, rowsFor(ids))
  const labelOf = (id: string) => optionLabel(src, known.get(id)) || id.slice(0, 8)

  return (
    <Autocomplete
      selectionMode="multiple"
      value={props.value}
      onChange={(keys: (string | number)[]) => emit(keys.map(String))}
      isDisabled={props.isDisabled}
      isRequired={props.isRequired}
      allowsEmptyCollection
      onOpenChange={setOpen}
    >
      {props.label && <Label>{props.label}</Label>}
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {props.value.length === 0 ? (
            <span className="text-muted">{props.placeholder ?? '请选择…'}</span>
          ) : (
            <TagGroup
              size="sm"
              aria-label="已选"
              onRemove={(keys) => emit(props.value.filter((id) => !new Set([...keys].map(String)).has(id)))}
            >
              <TagGroup.List>
                {props.value.map((id) => {
                  const row = known.get(id)
                  return (
                    <Tag key={id} id={id} textValue={labelOf(id)}>
                      {row && props.renderValue ? props.renderValue(row) : labelOf(id)}
                    </Tag>
                  )
                })}
              </TagGroup.List>
            </TagGroup>
          )}
        </Autocomplete.Value>
        <Autocomplete.ClearButton />
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <RemoteOptionsPopover src={src} draft={draft} onDraft={setDraft} options={options} renderItem={props.renderItem} />
    </Autocomplete>
  )
}
```

- [ ] **Step 4: tsc 校验(HeroUI anatomy 修正点)**

```bash
cd "$WT/web" && bunx tsc --noEmit
```

Expected: 无错误。若 Autocomplete/TagGroup/ListBoxLoadMoreItem 的 props 或导入路径报错,用 `heroui-pro` MCP `get_component_docs`(autocomplete / tag-group / list-box)按官方 anatomy 修正——已知不确定点:`ListBoxLoadMoreItem` 可能需从 `react-aria-components` 导入;`Autocomplete.Value` 的 children/render 形态;单选 `onChange` 回参是 `Key | null` 还是 `Key[]`;`ClearButton` 是否内建清空(若是,删掉手动 onPress)。

- [ ] **Step 5: Commit**

```bash
cd "$WT" && git add web/app/components/synie-remote-select/ && git commit -m "feat: RemoteSelect/RemoteMultiSelect——Autocomplete 远程搜索+无限滚动+chips 回填"
```

---

### Task 5: SynieDataGrid fk 单元格 + fk 筛选

**Files:**
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`(defaultCell 传 row)
- Modify: `web/app/components/synie-data-grid/filter-popover.tsx`(FkFilter)

**Interfaces:**
- Consumes: Task 4 `RemoteMultiSelect`;Task 2 `cellText(col, value, row)`、`ColumnFilter` fk 成员
- Produces: fk 列单元格显示 join label;列头筛选弹层出 RemoteMultiSelect,产出 `{kind:'fk', values, labels}`

- [ ] **Step 1: 单元格**

`SynieDataGrid.tsx` 的 `defaultCell` 签名与首行改为:

```ts
function defaultCell(col: GridColumnMeta, value: unknown, row: Row): ReactNode {
  if (col.type === 'fk' && col.ref) {
    const text = cellText(col, value, row)
    return text || <span className="text-muted">—</span>
  }
  if (value == null || value === '') return <span className="text-muted">—</span>
  // …以下原样
```

调用处(gridColumns 的 cell)改为:

```ts
        cell: (row: Row) => overrides[col.name]?.render?.(row[col.name], row) ?? defaultCell(col, row[col.name], row),
```

- [ ] **Step 2: 筛选控件**

`filter-popover.tsx`:导入区加:

```ts
import { RemoteMultiSelect } from '../synie-remote-select/RemoteMultiSelect'
import type { GridColumnRef } from './types'
```

`FilterControl` 的 switch 加分支(`case 'enum'` 之后):

```tsx
    case 'fk':
      // ref 为 null 时后端已标 filterable=false,不会走到这里;防御性放空
      return column.ref ? (
        <FkFilter colRef={column.ref} filter={filter?.kind === 'fk' ? filter : undefined} onChange={onChange} />
      ) : null
```

文件内(TextFilter 之前)加:

```tsx
function FkFilter({
  colRef,
  filter,
  onChange,
}: {
  colRef: GridColumnRef
  filter: Extract<ColumnFilter, { kind: 'fk' }> | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  return (
    <RemoteMultiSelect
      resource={colRef.resource}
      labelField={colRef.labelField}
      value={filter?.values ?? []}
      placeholder="选择筛选值…"
      onChange={(ids, rows) => {
        if (ids.length === 0) return onChange(null)
        const byId = new Map(rows.map((r) => [r.id, r]))
        onChange({
          kind: 'fk',
          values: ids,
          labels: ids.map((id) => {
            const r = byId.get(id)
            return r && r[colRef.labelField] != null ? String(r[colRef.labelField]) : id.slice(0, 8)
          }),
        })
      }}
    />
  )
}
```

- [ ] **Step 3: 校验 + Commit**

```bash
cd "$WT/web" && bunx tsc --noEmit && bun app/components/synie-data-grid/grid-checks.ts
cd "$WT" && git add web/app/components/synie-data-grid/ && git commit -m "feat: SynieDataGrid 外键列——单元格显示 join label,列头筛选出远程多选"
```

---

### Task 6: SynieDataGrid picker 模式(TDD)

**Files:**
- Create: `web/app/components/synie-data-grid/pick.ts`
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`
- Test: `web/app/components/synie-data-grid/grid-checks.ts`(追加)

**Interfaces:**
- Produces(Task 7 依赖):
  - `SynieDataGridProps` 新增:`pick?: 'single' | 'multiple'`、`pickedRows?: Row[]`、`onPickChange?: (rows: Row[]) => void`
  - picker 模式:隐藏工具栏动作/行菜单/批量条,选中完全受控,跨页/跨搜索累积
  - `mergePick(prev: Row[], pageRows: Row[], selection: Selection, mode: 'single' | 'multiple'): Row[]`(`pick.ts`)

- [ ] **Step 1: 写失败的自检**

`grid-checks.ts` 末尾 `console.log` 之前追加(import 区补 `import { mergePick } from './pick'`,`import type { Selection } from 'react-aria-components'`):

```ts
// —— picker 跨页累积选中 ——
const r = (id: string): Row => ({ id }) as Row
const page1 = [r('a'), r('b')]
const page2 = [r('c'), r('d')]
eq(mergePick([], page1, new Set(['a']) as Selection, 'multiple').map((x) => x.id), ['a'], '多选:本页勾选')
eq(mergePick([r('a')], page1, new Set(['a', 'b']) as Selection, 'multiple').map((x) => x.id), ['a', 'b'], '多选:本页追加')
eq(mergePick([r('a')], page2, new Set(['a', 'c']) as Selection, 'multiple').map((x) => x.id), ['a', 'c'], '多选:翻页保留非本页选中')
eq(mergePick([r('a'), r('c')], page1, new Set(['c']) as Selection, 'multiple').map((x) => x.id), ['c'], '多选:本页取消勾选被移除')
eq(mergePick([r('a')], page1, 'all', 'multiple').map((x) => x.id), ['a', 'b'], '多选:全选=本页全选')
eq(mergePick([], page1, new Set(['b']) as Selection, 'single').map((x) => x.id), ['b'], '单选:点行选中')
eq(mergePick([r('b')], page1, new Set() as Selection, 'single').map((x) => x.id), [], '单选:同页取消清空')
eq(mergePick([r('b')], page2, new Set(['b']) as Selection, 'single').map((x) => x.id), ['b'], '单选:翻页保留')
eq(mergePick([r('b')], page2, new Set(['c']) as Selection, 'single').map((x) => x.id), ['c'], '单选:换页改选替换')
```

跑 `bun app/components/synie-data-grid/grid-checks.ts`,Expected: FAIL——`Cannot find module './pick'`。

- [ ] **Step 2: 实现 pick.ts**

```ts
import type { Selection } from 'react-aria-components'
import type { Row } from './types'

/**
 * 跨页/跨搜索累积选中:本页以 selection 为准(勾了加、去了删),不在本页的历史选中原样保留。
 * single 只留一条:本页有选中即替换;本页无选中 = 取消(清掉本页的),翻页场景自然保留。
 */
export function mergePick(prev: Row[], pageRows: Row[], selection: Selection, mode: 'single' | 'multiple'): Row[] {
  const pageIds = new Set(pageRows.map((r) => r.id))
  const sel = selection === 'all' ? new Set(pageRows.map((r) => r.id)) : new Set([...selection].map(String))
  if (mode === 'single') {
    const hit = pageRows.find((row) => sel.has(row.id))
    if (hit) return [hit]
    return prev.filter((row) => !pageIds.has(row.id))
  }
  return [...prev.filter((row) => !pageIds.has(row.id)), ...pageRows.filter((row) => sel.has(row.id))]
}
```

- [ ] **Step 3: SynieDataGrid 接线**

`SynieDataGridProps` 追加(`rowActions` 之后):

```ts
  /** 选择器模式:表格作为弹窗选择器主体,隐藏动作/批量条,选中受控且跨页累积 */
  pick?: 'single' | 'multiple'
  pickedRows?: Row[]
  onPickChange?: (rows: Row[]) => void
```

组件内(`const meta = useGridMeta(resource)` 附近)加:

```ts
  const pickMode = props.pick != null
```

以下五处按 pickMode 分流:

1. 导出按钮不出现:`useGridActions({...})` 调用里 `onExport: handleExport,` 改为 `onExport: pickMode ? undefined : handleExport,`;同理 `onPrintRows: pickMode ? undefined : handlePrintRows,`。
2. 行菜单列:`const hasRowMenu = !pickMode && rows.some((r) => actions.rowMenuFor(r).length > 0)`。
3. 批量条:`const hasBulkActions = !pickMode && actions.bulkBarActions.length > 0`。
4. DataGrid 选择 props 改为:

```tsx
        selectionMode={pickMode ? props.pick : hasBulkActions ? 'multiple' : 'none'}
        showSelectionCheckboxes={pickMode ? props.pick === 'multiple' : hasBulkActions}
        selectedKeys={pickMode ? new Set((props.pickedRows ?? []).map((r) => r.id)) : selection}
        onSelectionChange={
          pickMode
            ? (sel: Selection) => props.onPickChange?.(mergePick(props.pickedRows ?? [], rows, sel, props.pick!))
            : setSelection
        }
```

5. import 区加 `import { mergePick } from './pick'`。

(工具栏 create/import 按钮依赖调用方传回调,picker 调用方不传即不出现,无需额外门控。)

- [ ] **Step 4: 校验 + Commit**

```bash
cd "$WT/web" && bun app/components/synie-data-grid/grid-checks.ts && bunx tsc --noEmit
cd "$WT" && git add web/app/components/synie-data-grid/ && git commit -m "feat: SynieDataGrid picker 模式——受控跨页选中,隐藏动作栏(mergePick 自检)"
```

---

### Task 7: RemoteDialogSelect / RemoteDialogMultiSelect

**Files:**
- Create: `web/app/components/synie-remote-select/RemoteDialogSelect.tsx`
- Create: `web/app/components/synie-remote-select/RemoteDialogMultiSelect.tsx`

**Interfaces:**
- Consumes: Task 6 picker 模式;Task 3 hooks/纯函数;HeroUI `Modal/Button/CloseButton/Label/Chip`
- Produces(Task 8 依赖):
  - `RemoteDialogSelectProps` = RemoteSelectProps + `dialogTitle?: string`
  - `RemoteDialogMultiSelectProps` = RemoteMultiSelectProps + `dialogTitle?: string`

- [ ] **Step 1: 实现 RemoteDialogSelect.tsx**

```tsx
import { useState } from 'react'
import { Button, CloseButton, Label, Modal } from '@heroui/react'
import { SynieDataGrid } from '../synie-data-grid/SynieDataGrid'
import type { Row } from '../synie-data-grid/types'
import { optionLabel, resolveSource } from './remote-query'
import { useRemoteRecords } from './use-remote'
import type { RemoteSelectProps } from './RemoteSelect'

export interface RemoteDialogSelectProps extends RemoteSelectProps {
  dialogTitle?: string
}

export function RemoteDialogSelect(props: RemoteDialogSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  // 弹窗内草稿,确认才提交
  const [draft, setDraft] = useState<Row[]>([])

  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  const resolved = useRemoteRecords(src, props.value != null && !known.has(props.value) ? [props.value] : [])
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const selectedRow = props.value != null ? (known.get(props.value) ?? null) : null
  const display = selectedRow
    ? (props.renderValue?.(selectedRow) ?? optionLabel(src, selectedRow))
    : props.value != null
      ? String(props.value).slice(0, 8)
      : null

  return (
    <>
      <div className="flex flex-col gap-1">
        {props.label && <Label>{props.label}</Label>}
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            className="min-w-0 flex-1 justify-between"
            isDisabled={props.isDisabled}
            onPress={() => {
              setDraft(selectedRow ? [selectedRow] : [])
              setOpen(true)
            }}
          >
            <span className="truncate">{display ?? <span className="text-muted">{props.placeholder ?? '点击选择…'}</span>}</span>
            <MagnifierIcon />
          </Button>
          {props.value != null && !props.isDisabled && (
            <CloseButton aria-label="清除选择" onPress={() => props.onChange(null, null)} />
          )}
        </div>
      </div>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        {/* size lg 仅 512px,className 覆盖成宽弹窗(tailwind-variants 合并) */}
        <Modal.Container size="lg" className="max-w-4xl">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{props.dialogTitle ?? `选择${props.label ?? ''}`}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <SynieDataGrid resource={src.resource} pick="single" pickedRows={draft} onPickChange={setDraft} />
            </Modal.Body>
            <Modal.Footer>
              <span className="mr-auto text-sm text-muted">
                已选:{draft[0] ? optionLabel(src, draft[0]) : '未选择'}
              </span>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button
                isDisabled={draft.length === 0}
                onPress={() => {
                  props.onChange(draft[0].id, draft[0])
                  setOpen(false)
                }}
              >
                确认
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}

function MagnifierIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  )
}
```

- [ ] **Step 2: 实现 RemoteDialogMultiSelect.tsx**

```tsx
import { useState } from 'react'
import { Button, Chip, CloseButton, Label, Modal } from '@heroui/react'
import { SynieDataGrid } from '../synie-data-grid/SynieDataGrid'
import type { Row } from '../synie-data-grid/types'
import { optionLabel, resolveSource } from './remote-query'
import { useRemoteRecords } from './use-remote'
import type { RemoteMultiSelectProps } from './RemoteMultiSelect'

export interface RemoteDialogMultiSelectProps extends RemoteMultiSelectProps {
  dialogTitle?: string
}

export function RemoteDialogMultiSelect(props: RemoteDialogMultiSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Row[]>([])

  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  const resolved = useRemoteRecords(src, props.value.filter((id) => !known.has(id)))
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const labelOf = (row: Row) => optionLabel(src, row)

  const openDialog = () => {
    // 草稿从当前值起步:已知行进草稿,未知 id 丢弃(确认时等于清掉了查不到的值,符合直觉)
    setDraft(props.value.map((id) => known.get(id)).filter((r): r is Row => r != null))
    setOpen(true)
  }

  /** 已选面板条目(桌面右栏与移动端 chips 共用移除逻辑) */
  const removeDraft = (id: string) => setDraft((prev) => prev.filter((r) => r.id !== id))

  return (
    <>
      <div className="flex flex-col gap-1">
        {props.label && <Label>{props.label}</Label>}
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            className="min-w-0 flex-1 justify-between"
            isDisabled={props.isDisabled}
            onPress={openDialog}
          >
            <span className="truncate">
              {props.value.length > 0 ? (
                `已选 ${props.value.length} 项`
              ) : (
                <span className="text-muted">{props.placeholder ?? '点击选择…'}</span>
              )}
            </span>
            <MagnifierIcon />
          </Button>
          {props.value.length > 0 && !props.isDisabled && (
            <CloseButton aria-label="清除选择" onPress={() => props.onChange([], [])} />
          )}
        </div>
      </div>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="lg" className="max-w-5xl">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{props.dialogTitle ?? `选择${props.label ?? ''}`}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {/* 移动端(<lg):已选转为表格上方 chips 行 */}
              {draft.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-1 lg:hidden">
                  {draft.map((row) => (
                    <Chip key={row.id} size="sm" className="pr-1">
                      <Chip.Label>{labelOf(row)}</Chip.Label>
                      <CloseButton
                        aria-label={`移除 ${labelOf(row)}`}
                        className="h-4 w-4 [&_svg]:size-3"
                        onPress={() => removeDraft(row.id)}
                      />
                    </Chip>
                  ))}
                </div>
              )}
              <div className="flex gap-4">
                <div className="min-w-0 flex-1">
                  <SynieDataGrid resource={src.resource} pick="multiple" pickedRows={draft} onPickChange={setDraft} />
                </div>
                {/* 桌面右侧已选面板:跨页/跨搜索累积,可单个移除 */}
                <aside className="hidden w-56 shrink-0 flex-col gap-2 lg:flex">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">已选 {draft.length} 项</span>
                    {draft.length > 0 && (
                      <Button size="sm" variant="ghost" onPress={() => setDraft([])}>
                        清空
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 overflow-y-auto">
                    {draft.length === 0 && <span className="text-sm text-muted">在左侧勾选记录</span>}
                    {draft.map((row) => (
                      <div key={row.id} className="flex items-center justify-between gap-2 rounded-md border border-separator px-2 py-1">
                        <span className="truncate text-sm">{labelOf(row)}</span>
                        <CloseButton aria-label={`移除 ${labelOf(row)}`} className="h-4 w-4 [&_svg]:size-3" onPress={() => removeDraft(row.id)} />
                      </div>
                    ))}
                  </div>
                </aside>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button
                onPress={() => {
                  props.onChange(draft.map((r) => r.id), draft)
                  setOpen(false)
                }}
              >
                确认({draft.length})
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}

function MagnifierIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  )
}
```

- [ ] **Step 3: 校验 + Commit**

```bash
cd "$WT/web" && bunx tsc --noEmit
cd "$WT" && git add web/app/components/synie-remote-select/ && git commit -m "feat: RemoteDialog(Multi)Select——Modal 内嵌 SynieDataGrid 选择器,多选左表格右已选面板"
```

Expected: tsc 无错误(Modal anatomy 报错时查 `get_component_docs` modal;`border-separator` 等 token 不存在时按 web/app.css 现有语义色改)。

---

### Task 8: SynieRecordDrawer fk 接入(TDD)

**Files:**
- Modify: `web/app/components/synie-record-drawer/fields.ts`
- Modify: `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx`
- Test: `web/app/components/synie-record-drawer/record-drawer-checks.ts`(追加)

**Interfaces:**
- Consumes: Task 4 `RemoteSelect`、Task 7 `RemoteDialogSelect`、Task 3 `resolveSource`/`useRemoteRecords`
- Produces:`FieldOverride` 新增 `picker?: 'select' | 'dialog'`、`remote?: Partial<RemoteSourceConfig>`;fk 列 create/edit 自动出 RemoteSelect(picker:'dialog' 切弹窗),view 显示解析 label;ref 被裁剪且无 remote.resource 时退化 TextField

- [ ] **Step 1: 写失败的自检**

`record-drawer-checks.ts`:`cols` 数组中把 `col('customerId', 'string')` 与 `col('supplierId', 'string')` 之间插入一个真 fk 列(col 辅助不含 ref,单独字面量):

```ts
const parentCol: GridColumnMeta = {
  name: 'parentId',
  type: 'fk',
  label: '上级公司',
  sortable: false,
  filterable: true,
  enumOptions: null,
  ref: { resource: 'basCompanies', relation: 'parent', labelField: 'name' },
}
```

(插到 `cols` 定义之后,再 `cols.push(parentCol)` 或直接并入数组字面量。)文件尾部 `console.log` 之前追加:

```ts
// —— fk 字段:初值归一 + picker/remote 透传 ——
const fkFields = resolveFields([parentCol], 'create', [], {
  parentId: { picker: 'dialog', remote: { searchFields: ['name', 'code'] } },
})
eq(fkFields[0].picker, 'dialog', 'picker 透传')
eq(fkFields[0].remote?.searchFields, ['name', 'code'], 'remote 透传')
eq(initialValues(fkFields, null).parentId, null, 'create fk 初值 null')
eq(
  initialValues(resolveFields([parentCol], 'edit', [], {}), { id: '1', parentId: 'u-1' } as unknown as Row).parentId,
  'u-1',
  'edit fk 从行数据取 id'
)
eq(
  initialValues(resolveFields([parentCol], 'edit', [], {}), { id: '1', parentId: null } as unknown as Row).parentId,
  null,
  'edit fk 空保持 null(不得归一为空串)'
)
```

import 区确认已有 `GridColumnMeta` 类型导入。跑 `bun app/components/synie-record-drawer/record-drawer-checks.ts`,Expected: FAIL(picker 不存在 / fk 初值走 default 分支变 `''`)。

- [ ] **Step 2: 实现 fields.ts**

`FieldOverride`(与 `ResolvedField` 同步)追加两个字段:

```ts
  /** fk 控件形态:默认 'select'(下拉);'dialog' 弹窗表格选择 */
  picker?: 'select' | 'dialog'
  /** fk 数据源定制(searchFields/renderItem/renderValue/filter…);resource 缺省取列 ref */
  remote?: Partial<RemoteSourceConfig>
```

顶部加 `import type { RemoteSourceConfig } from '../synie-remote-select/remote-query'`。`resolveFields` 的 map 返回对象追加:

```ts
        picker: o.picker,
        remote: o.remote,
```

`initialValues` 的 switch 中 `case 'enum':` 改为合并分支(fk 值语义同 enum:id 串或 null,空不得归一为空串——GraphQL uuid 不吃空串):

```ts
      case 'enum':
      case 'fk':
        out[f.name] = row ? (raw == null ? null : String(raw)) : (f.defaultValue ?? null)
        break
```

- [ ] **Step 3: 实现 SynieRecordDrawer.tsx**

import 区加:

```ts
import { RemoteSelect } from '../synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '../synie-remote-select/RemoteDialogSelect'
import { resolveSource } from '../synie-remote-select/remote-query'
import { useRemoteRecords } from '../synie-remote-select/use-remote'
import type { GridColumnMeta } from '../synie-data-grid/types'
```

`FieldInput` 加 `row` 参数(签名与两处调用):组件 props 加 `row?: Row | null`,渲染处 `<FieldInput field={f} row={renderRow} …/>`。`FieldInput` 函数体 `if (field.input) …` 之后、switch 之前插入:

```tsx
  // fk 列:ref(权限裁剪后)或页面 remote.resource 提供数据源;都没有则落到 default TextField(fail-closed)
  if (field.col.type === 'fk') {
    const ref = field.col.ref
    const cfg = { resource: ref?.resource, labelField: ref?.labelField, ...field.remote }
    if (cfg.resource) {
      const rel = ref && row ? ((row[ref.relation] as Row | null | undefined) ?? null) : null
      const common = {
        ...(cfg as RemoteSourceConfig & { resource: string }),
        label: field.label,
        value: value == null || value === '' ? null : String(value),
        onChange: (id: string | null) => onChange(id),
        isDisabled,
        isRequired: field.required,
        placeholder: field.placeholder,
        initialRows: rel ? [rel] : undefined,
      }
      return field.picker === 'dialog' ? <RemoteDialogSelect {...common} /> : <RemoteSelect {...common} />
    }
  }
```

(顶部补 `import type { RemoteSourceConfig } from '../synie-remote-select/remote-query'`。)

`ViewField`:fk 分支改走解析组件——函数体开头加:

```tsx
  if (field.col.type === 'fk' && field.col.ref && !field.render) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted">{field.label}</span>
        <div className="text-sm">
          <FkText col={field.col} row={row} />
        </div>
      </div>
    )
  }
```

文件内(ViewField 之后)加:

```tsx
/** view 态外键文本:行数据有 join 直接用;否则按 id 反查;都拿不到显示截断 id */
function FkText({ col, row }: { col: GridColumnMeta; row: Row }) {
  const ref = col.ref!
  const id = row[col.name] == null ? null : String(row[col.name])
  const rel = (row[ref.relation] as Row | null | undefined) ?? null
  const src = resolveSource({}, ref)
  const resolved = useRemoteRecords(src, rel || !id ? [] : [id])
  if (!id) return <span className="text-muted">—</span>
  const target = rel ?? resolved.data?.[0]
  return <>{target?.[ref.labelField] != null ? String(target[ref.labelField]) : id.slice(0, 8)}</>
}
```

- [ ] **Step 4: 校验 + Commit**

```bash
cd "$WT/web" && bun app/components/synie-record-drawer/record-drawer-checks.ts && bunx tsc --noEmit
cd "$WT" && git add web/app/components/synie-record-drawer/ && git commit -m "feat: SynieRecordDrawer 外键字段——三态自动出 RemoteSelect,picker/remote override,view 解析 label"
```

---

### Task 9: 公司管理试点页 + 菜单

**Files:**
- Create: `web/app/routes/_app/system/companies.tsx`
- Modify: `web/app/lib/menu.ts`

**Interfaces:**
- Consumes: 全部前序任务;后端 `createBasCompany`/`updateBasCompany`(已存在)
- Produces: 无(叶子页面)

- [ ] **Step 1: 新建 companies.tsx**

照 roles.tsx 样板(`web/app/routes/_app/system/roles.tsx`):

```tsx
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/companies')({
  component: CompaniesPage,
})

const CREATE_COMPANY = `
  mutation ($input: CreateBasCompanyInput!) {
    createBasCompany(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_COMPANY = `
  mutation ($id: ID!, $input: UpdateBasCompanyInput!) {
    updateBasCompany(id: $id, input: $input) { result { id } errors { message } }
  }
`

function CompaniesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">公司管理</h1>
      <p className="mt-2 text-sm text-ink-500">多公司主数据与集团层级。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="basCompanies"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="basCompanies"
        label="公司"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '两位英文字母,如 SH' },
          name: { required: true, placeholder: '如 上海总部' },
          shortName: { required: true, placeholder: '如 上海' },
          // parentId 是 fk 列,零配置自动出 RemoteSelect;要弹窗选择时:parentId: { picker: 'dialog' }
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createBasCompany: { errors: { message: string }[] | null } }>(
              CREATE_COMPANY,
              { input: values }
            )
            errors = data.createBasCompany.errors
          } else {
            const data = await gqlFetch<{ updateBasCompany: { errors: { message: string }[] | null } }>(
              UPDATE_COMPANY,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateBasCompany.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '公司已创建' : '公司已更新')
          setReloadKey((k) => k + 1)
        }}
      />
    </>
  )
}
```

- [ ] **Step 2: 菜单入口**

`web/app/lib/menu.ts` system 模块「组织权限」组 items 末尾(角色权限之后)加:

```ts
          { label: '公司管理', path: '/system/companies' },
```

- [ ] **Step 3: 校验 + Commit**

```bash
cd "$WT/web" && bunx tsc --noEmit
cd "$WT" && git add web/app/routes/_app/system/companies.tsx web/app/lib/menu.ts web/app/routeTree.gen.ts && git commit -m "feat: 公司管理试点页——parentId 外键三态+筛选走 RemoteSelect"
```

(routeTree.gen.ts 由 dev server/`bun run dev` 启动时自动生成;若 tsc 报路由不存在,先起一次 dev server 再跑 tsc。)

---

### Task 10: 浏览器走查 + 终局闸门

**Files:** 无新文件(发现问题就地修,随修随提交)

- [ ] **Step 1: 起服务 + 造数据**

```bash
export PATH="$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$HOME/.elixir-install/installs/otp/28.4/bin:$PATH"
cd "$WT/backend" && mix phx.server   # 后台跑,端口 4000
```

```bash
cd "$WT/web" && bun run dev   # 后台跑,vite 代理 /graphql → 4000
```

无限滚动需要 20+ 条公司,psql 批量造(容器 synie-pg,库名/用户以 `backend/config/dev.exs` 为准,下面按 postgres/synie_dev 写):

```bash
docker exec synie-pg psql -U postgres -d synie_dev -c "
INSERT INTO bas_company (id, code, name, short_name, inserted_at, updated_at)
SELECT gen_random_uuid(), chr(67 + i / 26) || chr(65 + i % 26), '测试公司' || i, '测' || i, now(), now()
FROM generate_series(0, 29) AS i;"
```

- [ ] **Step 2: 走查(playwright MCP,登录 admin/admin123)**

打开 `http://localhost:<dev端口>/system/companies`,逐项确认:

1. 新增「AA 集团总部」(上级留空)→ 保存成功;新增「AB 华东子公司」,上级公司下拉点开 → 首屏 20 条按名称升序,输入「集团」→ 防抖后只剩集团总部,选中 → 触发区回填「集团总部」→ 保存。
2. 表格 parentId 列:AB 行显示「集团总部」(label 而非 uuid);无上级的行显示「—」。
3. 无限滚动:上级公司下拉不输入关键字,滚到列表底部 → 自动加载第二页(网络面板确认 offset: 20 请求)。
4. 列头「上级公司」筛选 → 弹层出远程多选,选「集团总部」→ 表格只剩 AB;筛选 chip 文案「上级公司 集团总部」;清除恢复。
5. 查看 AB 详情 → 上级公司显示「集团总部」;点编辑 → RemoteSelect 已回填,清除后保存 → 详情/表格上级变「—」(parent_id 置 null 生效);再改回集团总部。
6. dialog 单选:companies.tsx 临时加 `parentId: { picker: 'dialog' }` → 触发区变按钮+放大镜,点开 → Sheet 之上弹 Modal 宽弹窗内嵌表格(层叠正常,ESC 只关 Modal 不关 Sheet),搜索/筛选/翻页可用,点行选中 → footer 显示已选 → 确认回填;验证完删掉这行 override。
7. RemoteDialogMultiSelect:companies.tsx 临时挂演示(页面顶部 `const [demo, setDemo] = useState<string[]>([])` + `<RemoteDialogMultiSelect resource="basCompanies" label="演示多选" value={demo} onChange={(ids) => setDemo(ids)} />`)→ 桌面左表格右已选面板;第一页勾 2 条、翻页再勾 1 条 → 右侧 3 条都在;搜索后再勾 → 已选保留;单个移除、清空、确认(触发区显示「已选 N 项」)都正常;验证完删除演示代码。
8. 视口 375×812:多选弹窗已选转为表格上方 chips 行;抽屉表单单列;下拉弹层搜索框不自动弹键盘。
9. 浏览器 console 无红色报错(RAC 受控组件警告零容忍)。

- [ ] **Step 3: 终局闸门 + 收尾提交**

```bash
cd "$WT/web" && bunx tsc --noEmit \
  && bun app/components/synie-data-grid/grid-checks.ts \
  && bun app/components/synie-record-drawer/record-drawer-checks.ts \
  && bun app/components/synie-remote-select/remote-select-checks.ts
cd "$WT/backend" && mix test
```

Expected: 全绿。走查修复一并提交(提交信息如 `fix: 外键控件走查修复——<问题>`);清理测试数据(psql delete `code like '测%'` 的 bas_company 与走查建的 AA/AB)。
