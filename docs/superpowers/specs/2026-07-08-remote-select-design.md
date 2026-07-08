# RemoteSelect 外键控件族设计

2026-07-08。四个外键控件:RemoteSelect / RemoteMultiSelect(弹层搜索下拉)+ RemoteDialogSelect / RemoteDialogMultiSelect(弹窗表格选择),打通 SynieRecordDrawer(表单三态)与 SynieDataGrid(单元格显示 + 筛选)的外键能力。元数据由后端 GridMeta 反射 belongs_to 提供。

## 组件家族与值语义

统一值语义:value = 外键 id(单选 `string | null`,多选 `string[]`),`onChange(id(s), row(s))` 附带选中整行供页面联动。

| 控件 | 形态 | 场景 |
|---|---|---|
| RemoteSelect | 触发按钮 + 弹层内搜索 + 无限滚动列表 | 表单默认外键控件 |
| RemoteMultiSelect | 同上,chips 回填多选 | 表格 fk 筛选、M2M 表单 |
| RemoteDialogSelect | Modal 内嵌 SynieDataGrid 单选 | 数据量大/要看多列再选 |
| RemoteDialogMultiSelect | Modal 左表格 + 右已选面板 | 批量挑选 |

回显:只有 id 时组件按 id 批量反查(`filter: {id: {in: [...]}}`)解析显示数据;有现成行数据传 `initialRows` 短路反查;查不到(已删/无权限)显示截断 id,不报错。

```ts
interface RemoteSourceConfig {
  resource: string                 // GridMeta 白名单资源名
  labelField?: string              // 默认取 gridMeta ref.labelField
  searchFields?: string[]          // 远程搜索 contains OR 字段,默认 [labelField]
  filter?: string                  // 固定过滤字面量(如只选启用的)
  fields?: string[]                // 额外取回字段供 renderItem 用
  pageSize?: number                // 默认 20
  renderItem?: (row: Row) => ReactNode    // 下拉项,默认 label 单行
  renderValue?: (row: Row) => ReactNode   // 选中回填,默认 label 文本/chip
}

interface RemoteSelectProps extends RemoteSourceConfig {
  value: string | null
  onChange: (id: string | null, row: Row | null) => void
  isDisabled?: boolean
  placeholder?: string
  initialRows?: Row[]
}
// RemoteMultiSelect: value: string[], onChange(ids, rows)
// RemoteDialog(Multi)Select: 同值语义,另加 dialogTitle?;弹窗列即目标资源 gridMeta 列
```

## 后端 GridMeta 扩展

- `grid_column` 增加 `ref { resource, relation, labelField }`:反射 belongs_to,`relation` 是关系字段名(行查询 join 用),目标资源须在 `@resources` 白名单内(不在则不给 ref,列维持现状)。
- 显示字段约定默认 `:name`,目标资源可实现 `display_field/0` 覆盖。
- fk 列 `type: "fk"`、`filterable: true`(eq/in,不走 contains)、`sortable: false`(uuid 排序无意义)。
- 权限裁剪 fail-closed:resolve 时检查 actor 对目标资源的 read 权限,无权限 → `ref: null`,列退化为现状(uuid 文本、不可筛、表单退 TextField)。

## 非 dialog 基座:统一 Autocomplete

单选、多选都用 OSS Autocomplete(不用 ComboBox:其触发区是原生 input 只能回填字符串,满足不了 renderValue 富渲染)。多选用官方 `selectionMode="multiple"` + `Autocomplete.Value` render 里 TagGroup chips。

- 受控 `Autocomplete.Filter` inputValue 发远程请求,`filter={() => true}` 关客户端过滤;必加 `allowsEmptyCollection`(否则空列表弹层自动关);`ListBox.Item` 必填 `textValue`。
- 移动端弹层内 `SearchField autoFocus={false}`(避免立刻弹键盘)。
- 空态 `renderEmptyState`;加载态 Spinner 塞 SearchField。

## Dialog 基座:Modal + SynieDataGrid picker 模式

- SynieDataGrid 加 picker 模式:隐藏新建/行动作/批量动作栏,选中受控外露;免费获得列筛选、排序、分页、权限。
- 单选:点行即选,footer 显示当前选中 + 确认。多选:桌面左表格 + 右已选面板,跨页/跨搜索累积(组件内 id→row map,换页时同步勾选态),可单个移除、可清空;移动端(<lg)已选面板转为表格上方 chips 行。
- Modal 桌面宽弹窗:`size="lg"` 只有 512px,用 className `max-w` 覆盖(或 cover 档),`scroll="inside"`。
- 叠在记录抽屉 Sheet 之上:两者同 z-50、后挂载者胜,已核查无冲突;需实测 Modal 开着时 Sheet 的 outside-dismiss 是否误关(必要时 Modal 打开期间 Sheet `isDismissable={false}`)。
- 表单内触发区:只读值显示(可 renderValue)+ 放大镜 + 清除按钮。

## SynieRecordDrawer 集成

- fk 列(有 ref)自动出控件:create/edit 默认 RemoteSelect,view 显示解析 label(行数据有 join 字段直接用,否则反查)。
- `FieldOverride` 增加:`picker?: 'select' | 'dialog'`(默认 select)、`remote?: Partial<RemoteSourceConfig>`(定制搜索字段/渲染/固定过滤)。
- 提交 payload 即 `{deptId: id}`,与 Ash accept 的 `xxx_id` 对齐。
- M2M 多值关系不是 attribute、不进列反射,本轮不自动化;页面用现有 `input` override 塞 RemoteMultiSelect。

## SynieDataGrid 集成

- 单元格:行查询对有 ref 的列自动 join `relation { id labelField }`,显示 label,空值 `-`;ref null 时维持 uuid 文本。
- 筛选:新 filter kind `fk`(RemoteMultiSelect 非 dialog),生成 `{deptId: {in: [ids]}}`;ids 需过 uuid 格式校验再拼字面量(query.ts 手拼查询,防注入,enum 白名单先例);筛选 chip 显示 label(取自选中时缓存的 rows)。
- 全局搜索不跨 fk 列(join contains 不做)。

## 性能

- 弹层打开才发首个请求;搜索防抖复用 `use-debounced`。
- 无限滚动:官方 `ListBoxLoadMoreItem` + limit/offset 分页。
- react-query 缓存:options key `['remoteOptions', resource, filter, search, page]` 短 staleTime;by-id 回显 key `['remoteRecords', resource, ids]` 长 staleTime,一次 in 批量。
- 单元格 label 走行查询 join,零额外请求。

## 权限与边界

- 选项/反查都走 AshGraphql 现有 list query,Ash policy 与多公司过滤自动生效。
- 无目标资源 read 权限:后端裁剪 ref(见上),前端各处自然退化,不出半残控件。
- join 字段在 actor 无权限时的行为依赖后端裁剪兜底(无 ref 即不 join),不依赖 GraphQL 局部报错。

## 试点与验收

- 试点:公司管理页(`parent` 自引用外键)——补 domain queries/mutations、GridMeta 白名单 `sysCompanies`、新页面,照 roles 页四步法;验证单元格 label、fk 筛选、抽屉三态 RemoteSelect、`picker: 'dialog'` 手动切换。
- RemoteDialogMultiSelect 本轮无业务落点:组件自检 + 临时演示验证,待真实 M2M 页面接入。
- 闸门:`bunx tsc --noEmit`;纯函数(source 解析/选中累积/uuid 校验/回显归一)拆 bun 可跑自检文件(checks 先例);后端 GridMeta ref 反射测试;浏览器实测。

## 后续轮次(不在本轮)

- M2M 多值关系自动反射进表单元数据。
- RemoteDialogMultiSelect 业务页接入。
- 大列表虚拟滚动(官方 Virtualization,现无需求)。
