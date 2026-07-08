# SynieRecordDrawer 设计

2026-07-08。数据详情 + 数据录入表单的标准化组件：一个组件、三态切换（view/create/edit），复用 SynieDataGrid 的 GridMeta 元数据自动生成字段。本轮零后端改动。

## 组件形态

`web/app/components/synie-record-drawer/`，外壳 `@heroui-pro/react` Sheet `placement="right"`（移动端 `w-full`，桌面 `lg:w-[480px]` 起步，断点统一 `lg`）。

```ts
interface SynieRecordDrawerProps {
  resource: string                  // GridMeta 白名单名，与表格同
  mode: 'view' | 'create' | 'edit'
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  row?: Row | null                  // view/edit 数据源，直接用表格行数据，不按 id 重查
  exclude?: string[]                // 隐藏字段（叠加在自动剔除之上）
  fields?: Record<string, FieldOverride>
  onSubmit?: (values: Record<string, unknown>, mode: 'create' | 'edit') => Promise<void>
  onEdit?: () => void               // view 态 footer 显示"编辑"按钮，点击回调（页面切 mode）
}

interface FieldOverride {
  label?: string
  cols?: number                     // 1–12，默认 12（一行一个）
  required?: boolean
  edit?: 'editable' | 'createOnly' | 'readOnly'   // 默认 'editable'
  placeholder?: string              // 输入占位；readOnly 创建态用作"保存后自动生成"类提示
  defaultValue?: unknown            // create 态初值（如 enabled 默认 true）；不填按类型取 ''/false/null
  visible?: (values: Record<string, unknown>) => boolean   // 条件字段，默认恒真
  render?: (value: unknown, row: Row) => ReactNode          // view 态自定义渲染
  input?: (p: { value: unknown; onChange: (v: unknown) => void; isDisabled: boolean }) => ReactNode
                                    // 表单控件替换（外键本轮用它塞 TextField 顶着）
}
```

自动规则：`insertedAt/updatedAt` view 显示（默认 cols 6，桌面并排一行）、create/edit 剔除；`id` 三态都不显示（与表格过滤 id 对齐）。

## 字段编辑语义（edit 三值）

| | create | edit | view |
|---|---|---|---|
| `editable`（默认） | 输入 | 输入 | 显示 |
| `createOnly`（如 role.code） | 输入 | disabled 显示值 | 显示 |
| `readOnly`（计算字段、自动编号） | disabled 空框 + placeholder | disabled 显示值 | 显示 |

- 收集 values 时跳过当前 mode 下不可编辑的字段（disabled 值不进提交 payload）。
- 必填检查只对当前 mode 下可编辑的字段生效。
- 下一轮 GridMeta 扩表单元数据时，`edit` 可从 Ash action 的 accept 列表自动推导，手动标注是本轮过渡。

## 条件字段（visible 谓词）

- 隐藏字段不占格子，grid 后续字段自然补位。
- 隐藏字段不进提交 payload、不做必填检查。
- 草稿值保留本地 state（切走再切回不丢），提交时按当时可见性过滤。
- view 态同样生效，谓词入参为行数据。
- 用函数谓词不用声明式条件 DSL；代价是不可序列化，本轮字段配置在页面代码里，无碍。

## 布局

`grid grid-cols-1 lg:grid-cols-12 gap-4`，每字段 `lg:col-span-{cols}`，默认 12。移动端（<lg，项目守则统一断点 1024px）无条件单列，cols 只在桌面生效。Tailwind v4 JIT 扫不到动态类名，cols 1–12 用静态映射表。

## 控件分发与详情渲染

按 `GridColumnType` 分发（沿用 filter-popover 先例）：string→TextField、integer/decimal→NumberField、boolean→Switch、date/datetime→DatePicker、enum→Select(enumOptions)。view 态同一套 grid 布局，label + 格式化值，复用 `format.ts`——表格与详情显示一致。

## 提交与校验

不引入校验库：required 字段 HeroUI `isRequired` + 提交前空值检查，不过则 toast。`onSubmit` 抛错 → toast 显示、drawer 不关；成功 → 关闭。提交中按钮 pending。

## SynieDataGrid 集成

`SynieDataGrid` 加 `onView?: (row: Row) => void`，传了就在行内省略号菜单第一项加"查看"。不加新 capability 门控（能见表格行即有 read 权限）。

## 嵌套与 tabs（本轮只确认、不实现）

- 纵深视图：Pro Sheet 官方支持嵌套（`Sheet.NestedRoot`，接受与根相同 props），届时纯增量加 nested 能力；文档示例为 bottom 布局，right 布局堆叠动画届时实测。OSS Drawer 无嵌套支持，故统一用 Sheet。
- 平行视图（审计/编辑历史）：届时 `Sheet.Header` 放 Tabs，无需本轮预留接口。

## 试点与验收

roles 页迁移：删手写 Sheet 表单换 `SynieRecordDrawer`（code 标 `required + createOnly`，name 标 `required`），mutation 字符串留在页面进 onSubmit；表格加 onView 查看。

闸门：`bunx tsc --noEmit`；组件纯函数（字段解析/values 收集/必填检查/可见性过滤）拆进 bun 可直接跑的自检文件（grid-checks.ts 先例）；浏览器实测增/改/查三态。

## 后续轮次（不在本轮）

- RemoteSelect / RemoteMultiSelect / RemoteDialogSelect / RemoteDialogMultiSelect（外键控件）。
- GridMeta 扩表单元数据（createMutation/updateMutation/formFields，从 accept/allow_nil 推导 edit/required），组件运行时拼 mutation 自动提交，onSubmit 退为可选覆盖。
- 详情需要表格未取字段时，加 by-id 重查。
