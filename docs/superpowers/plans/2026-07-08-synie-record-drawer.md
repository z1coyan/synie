# SynieRecordDrawer 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 数据详情 + 数据录入表单标准化组件 SynieRecordDrawer——一个组件三态（view/create/edit），按 GridMeta 元数据自动生成字段，roles 页试点迁移，表格行菜单加「查看」。

**Architecture:** 纯函数层（字段解析/初值/收集/必填）+ 组件层（Sheet 右侧抽屉 + 12 栅格 + 按列类型分发控件）分离；元数据复用 `useGridMeta`，提交走页面 `onSubmit` 回调（本轮零后端改动）。设计 spec：`docs/superpowers/specs/2026-07-08-synie-record-drawer-design.md`。

**Tech Stack:** React 19 + TanStack Start + `@heroui/react` v3 + `@heroui-pro/react`（Sheet）+ `@tanstack/react-query` + 手写 `gqlFetch`。无测试框架——纯函数用 bun 直跑的 checks 文件（`grid-checks.ts` 先例）。

## Global Constraints

- 项目第一语言中文，所有 UI 文案、注释用中文。
- 桌面/移动断点统一 `lg`（1024px），不用 `sm`/`md` 做布局分界。
- 表单控件一律 HeroUI(Pro) 现成组件（TextField/NumberField/DatePicker/Select/Switch），不包装原生 input。
- 非幂等请求必须有 Toast 反馈与错误处理（web/CLAUDE.md 守则）。
- HeroUI v3 约定：子组件点号（`Sheet.Body`）、交互用 `onPress` 不用 `onClick`、无 Provider；本版 Select 受控用 `value`/`onChange`（`selectedKey` 已弃用）。
- 前端闸门：`bunx tsc --noEmit` 全绿 + `bun app/components/synie-record-drawer/record-drawer-checks.ts` 输出 ok。
- 工作目录：`/home/zyan/code/synie/.claude/worktrees/synie-record-drawer`（下称 `$WT`）。worktree 无 `web/node_modules`，Task 1 第一步软链主 checkout 的（`@heroui-pro/react` 真实包需 token 安装，勿在 worktree 重新 install）。
- Tailwind v4 JIT 扫不到动态拼接类名——栅格 span 用 1–12 静态映射表。

---

### Task 1: 纯函数层 fields.ts（TDD）

**Files:**
- Create: `web/app/components/synie-record-drawer/fields.ts`
- Test: `web/app/components/synie-record-drawer/record-drawer-checks.ts`

**Interfaces:**
- Consumes: `GridColumnMeta`、`Row`（`web/app/components/synie-data-grid/types.ts`，已存在）
- Produces（Task 2/4 依赖，签名以此为准）:
  - `type DrawerMode = 'view' | 'create' | 'edit'`
  - `type FieldEdit = 'editable' | 'createOnly' | 'readOnly'`
  - `interface FieldInputProps { value: unknown; onChange: (v: unknown) => void; isDisabled: boolean }`
  - `interface FieldOverride { label?; cols?; required?; edit?; placeholder?; defaultValue?; visible?; render?; input? }`
  - `interface ResolvedField { col: GridColumnMeta; name: string; label: string; cols: number; required: boolean; edit: FieldEdit; placeholder?: string; defaultValue?: unknown; visible?; render?; input? }`
  - `resolveFields(columns: GridColumnMeta[], mode: DrawerMode, exclude?: string[], overrides?: Record<string, FieldOverride>): ResolvedField[]`
  - `isFieldDisabled(f: ResolvedField, mode: DrawerMode): boolean`
  - `visibleFields(fields: ResolvedField[], values: Record<string, unknown>): ResolvedField[]`
  - `initialValues(fields: ResolvedField[], row: Row | null | undefined): Record<string, unknown>`
  - `collectValues(fields: ResolvedField[], values: Record<string, unknown>, mode: 'create' | 'edit'): Record<string, unknown>`
  - `missingRequired(fields: ResolvedField[], values: Record<string, unknown>, mode: 'create' | 'edit'): string[]`

- [ ] **Step 1: 软链 node_modules**

```bash
ln -sfn /home/zyan/code/synie/web/node_modules "$WT/web/node_modules"
cd "$WT/web" && bunx tsc --noEmit
```

Expected: tsc 通过（基线全绿）。若报缺模块，确认软链目标存在。

- [ ] **Step 2: 写失败的自检文件**

创建 `web/app/components/synie-record-drawer/record-drawer-checks.ts`：

```ts
// bun app/components/synie-record-drawer/record-drawer-checks.ts 可直接运行的纯函数自检
import {
  collectValues,
  initialValues,
  isFieldDisabled,
  missingRequired,
  resolveFields,
  visibleFields,
} from './fields'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'

const col = (name: string, type: GridColumnMeta['type'], enumOptions: GridColumnMeta['enumOptions'] = null): GridColumnMeta => ({
  name,
  type,
  label: `L:${name}`,
  sortable: true,
  filterable: true,
  enumOptions,
})

const cols: GridColumnMeta[] = [
  col('id', 'string'),
  col('code', 'string'),
  col('name', 'string'),
  col('seq', 'integer'),
  col('price', 'decimal'),
  col('enabled', 'boolean'),
  col('dueOn', 'date'),
  col('happenedAt', 'datetime'),
  col('counterpartyType', 'enum', [
    { value: 'customer', label: '客户' },
    { value: 'supplier', label: '供应商' },
  ]),
  col('customerId', 'string'),
  col('supplierId', 'string'),
  col('insertedAt', 'datetime'),
]

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
    process.exit(1)
  }
}

// —— resolveFields:系统字段 create/edit 剔除、view 保留;exclude 叠加;overrides 生效 ——
const createFields = resolveFields(cols, 'create', ['supplierId'], {
  code: { edit: 'createOnly', required: true },
  name: { cols: 6, label: '名称' },
})
eq(
  createFields.map((f) => f.name),
  ['code', 'name', 'seq', 'price', 'enabled', 'dueOn', 'happenedAt', 'counterpartyType', 'customerId'],
  'create 剔除 id/insertedAt 系统字段与 exclude'
)
eq(resolveFields(cols, 'view', [], {}).some((f) => f.name === 'insertedAt'), true, 'view 保留系统字段')
eq(createFields[0].edit, 'createOnly', 'override edit 生效')
eq(createFields[0].required, true, 'override required 生效')
eq(createFields.find((f) => f.name === 'name')!.cols, 6, 'override cols 生效')
eq(createFields.find((f) => f.name === 'name')!.label, '名称', 'override label 生效')
eq(createFields.find((f) => f.name === 'seq')!.cols, 12, '默认 cols=12')
eq(resolveFields(cols, 'create', [], { seq: { cols: 99 } }).find((f) => f.name === 'seq')!.cols, 12, 'cols 上限 12')

// —— isFieldDisabled 三值 × create/edit ——
const fOf = (edit?: 'editable' | 'createOnly' | 'readOnly') =>
  resolveFields([col('x', 'string')], 'create', [], { x: { edit } })[0]
eq(isFieldDisabled(fOf('editable'), 'create'), false, 'editable create 可输入')
eq(isFieldDisabled(fOf('editable'), 'edit'), false, 'editable edit 可输入')
eq(isFieldDisabled(fOf('createOnly'), 'create'), false, 'createOnly create 可输入')
eq(isFieldDisabled(fOf('createOnly'), 'edit'), true, 'createOnly edit 禁用')
eq(isFieldDisabled(fOf('readOnly'), 'create'), true, 'readOnly create 禁用')
eq(isFieldDisabled(fOf('readOnly'), 'edit'), true, 'readOnly edit 禁用')

// —— visibleFields:条件字段按当前 values 过滤 ——
const condFields = resolveFields(cols, 'create', [], {
  customerId: { visible: (v) => v.counterpartyType === 'customer' },
  supplierId: { visible: (v) => v.counterpartyType === 'supplier' },
})
eq(
  visibleFields(condFields, { counterpartyType: 'customer' }).some((f) => f.name === 'customerId'),
  true,
  '客户态显示 customerId'
)
eq(
  visibleFields(condFields, { counterpartyType: 'customer' }).some((f) => f.name === 'supplierId'),
  false,
  '客户态隐藏 supplierId'
)
eq(visibleFields(condFields, {}).some((f) => f.name === 'customerId'), false, '未选类型两者都不显示')
eq(visibleFields(condFields, {}).some((f) => f.name === 'name'), true, '无谓词字段恒显示')

// —— initialValues:create 按类型给空值 + defaultValue;edit 从行数据归一化 ——
const ivCreate = initialValues(resolveFields(cols, 'create', [], { enabled: { defaultValue: true } }), null)
eq(ivCreate.code, '', 'create string 初值空串')
eq(ivCreate.enabled, true, 'create defaultValue 生效')
eq(ivCreate.seq, null, 'create number 初值 null')
eq(ivCreate.dueOn, null, 'create date 初值 null')
eq(ivCreate.counterpartyType, null, 'create enum 初值 null')

const row: Row = {
  id: '1',
  code: 'a',
  name: null,
  seq: 3,
  price: '12.50',
  enabled: true,
  dueOn: '2026-01-05',
  happenedAt: '2026-01-05T08:30:00Z',
  counterpartyType: 'customer',
  customerId: 'c1',
  supplierId: null,
} as unknown as Row
const ivEdit = initialValues(resolveFields(cols, 'edit', [], {}), row)
eq(ivEdit.price, 12.5, 'edit decimal 字符串归一为 number')
eq(ivEdit.happenedAt, '2026-01-05', 'edit datetime ISO 截取日期位')
eq(ivEdit.dueOn, '2026-01-05', 'edit date 原样')
eq(ivEdit.name, '', 'edit string null 归一空串')
eq(ivEdit.enabled, true, 'edit boolean 原样')

// —— collectValues:createOnly 编辑态剔除;隐藏字段剔除;undefined 归 null ——
const submitFields = resolveFields(cols, 'edit', [], {
  code: { edit: 'createOnly' },
  customerId: { visible: (v) => v.counterpartyType === 'customer' },
  supplierId: { visible: (v) => v.counterpartyType === 'supplier' },
})
const submitted = collectValues(
  submitFields,
  { code: 'a', name: 'n', counterpartyType: 'supplier', customerId: 'c1', supplierId: 's1', seq: undefined },
  'edit'
)
eq('code' in submitted, false, 'createOnly 编辑态不进 payload')
eq('customerId' in submitted, false, '隐藏字段不进 payload(草稿仍在)')
eq(submitted.supplierId, 's1', '可见字段进 payload')
eq(submitted.name, 'n', '普通字段进 payload')
eq(submitted.seq, null, 'undefined 归 null')
eq('id' in submitted, false, '系统字段不进 payload')

const createSubmitted = collectValues(
  resolveFields(cols, 'create', [], { code: { edit: 'createOnly' }, price: { edit: 'readOnly' } }),
  { code: 'a', price: 1 },
  'create'
)
eq(createSubmitted.code, 'a', 'createOnly 创建态进 payload')
eq('price' in createSubmitted, false, 'readOnly 创建态不进 payload')

// —— missingRequired:只查当前可见且可编辑;false/0 不算空 ——
const reqFields = resolveFields(cols, 'create', [], {
  code: { required: true },
  seq: { required: true },
  enabled: { required: true },
  price: { required: true, edit: 'readOnly' },
  customerId: { required: true, visible: (v) => v.counterpartyType === 'customer' },
})
eq(
  missingRequired(reqFields, { code: '', seq: 0, enabled: false, counterpartyType: 'supplier' }, 'create'),
  ['L:code'],
  '空串缺失;0/false 不算空;readOnly 与隐藏的 required 不拦'
)
eq(
  missingRequired(reqFields, { code: 'a', seq: 1, enabled: false, counterpartyType: 'customer' }, 'create'),
  ['L:customerId'],
  '条件字段显形后必填生效'
)

console.log('record-drawer-checks ok')
```

- [ ] **Step 3: 跑自检确认失败**

```bash
cd "$WT/web" && bun app/components/synie-record-drawer/record-drawer-checks.ts
```

Expected: FAIL——`Cannot find module './fields'`。

- [ ] **Step 4: 实现 fields.ts**

创建 `web/app/components/synie-record-drawer/fields.ts`：

```ts
import type { ReactNode } from 'react'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'

export type DrawerMode = 'view' | 'create' | 'edit'
export type FieldEdit = 'editable' | 'createOnly' | 'readOnly'

export interface FieldInputProps {
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
}

export interface FieldOverride {
  label?: string
  /** 桌面(lg+)栅格宽度 1-12,默认 12;移动端恒单列 */
  cols?: number
  required?: boolean
  /** createOnly:编辑态禁用(如 code);readOnly:计算字段/自动编号,两态都禁用 */
  edit?: FieldEdit
  /** 输入占位;readOnly 字段创建态用作「保存后自动生成」类提示 */
  placeholder?: string
  /** create 态初值(如 enabled 默认 true);不填按类型取 ''/false/null */
  defaultValue?: unknown
  /** 条件字段:返回 false 则不渲染、不校验、不提交;view 态入参为行数据 */
  visible?: (values: Record<string, unknown>) => boolean
  /** view 态自定义渲染 */
  render?: (value: unknown, row: Row) => ReactNode
  /** 表单控件替换(外键本轮用 TextField 顶,下轮换 RemoteSelect) */
  input?: (p: FieldInputProps) => ReactNode
}

export interface ResolvedField {
  col: GridColumnMeta
  name: string
  label: string
  cols: number
  required: boolean
  edit: FieldEdit
  placeholder?: string
  defaultValue?: unknown
  visible?: (values: Record<string, unknown>) => boolean
  render?: (value: unknown, row: Row) => ReactNode
  input?: (p: FieldInputProps) => ReactNode
}

/** 系统字段:view 显示,create/edit 剔除。下轮 GridMeta 扩表单元数据后由后端 accept 列表推导 */
const SYSTEM_FIELDS = ['id', 'insertedAt', 'updatedAt']

export function resolveFields(
  columns: GridColumnMeta[],
  mode: DrawerMode,
  exclude: string[] = [],
  overrides: Record<string, FieldOverride> = {}
): ResolvedField[] {
  return columns
    .filter((c) => !exclude.includes(c.name))
    .filter((c) => mode === 'view' || !SYSTEM_FIELDS.includes(c.name))
    .map((c) => {
      const o = overrides[c.name] ?? {}
      return {
        col: c,
        name: c.name,
        label: o.label ?? c.label,
        cols: Math.min(12, Math.max(1, o.cols ?? 12)),
        required: o.required ?? false,
        edit: o.edit ?? 'editable',
        placeholder: o.placeholder,
        defaultValue: o.defaultValue,
        visible: o.visible,
        render: o.render,
        input: o.input,
      }
    })
}

/** 当前 mode 下该字段是否禁用(view 态不走表单,不经此函数) */
export function isFieldDisabled(f: ResolvedField, mode: DrawerMode): boolean {
  if (mode === 'edit') return f.edit !== 'editable'
  return f.edit === 'readOnly'
}

export function visibleFields(fields: ResolvedField[], values: Record<string, unknown>): ResolvedField[] {
  return fields.filter((f) => f.visible?.(values) ?? true)
}

/** 表单草稿初值:编辑从行数据按类型归一化,新建按类型给空值(defaultValue 优先) */
export function initialValues(fields: ResolvedField[], row: Row | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = row?.[f.name]
    switch (f.col.type) {
      case 'boolean':
        out[f.name] = row ? Boolean(raw) : (f.defaultValue ?? false)
        break
      case 'integer':
      case 'decimal': {
        // Ash decimal 经 GraphQL 常序列化为字符串,归一为 number
        const n = raw == null || raw === '' ? null : Number(raw)
        out[f.name] = row ? (typeof n === 'number' && Number.isFinite(n) ? n : null) : (f.defaultValue ?? null)
        break
      }
      case 'date':
      case 'datetime':
        // DatePicker 只吃 YYYY-MM-DD;datetime ISO 串截取日期位
        out[f.name] = row ? (raw ? String(raw).slice(0, 10) : null) : (f.defaultValue ?? null)
        break
      case 'enum':
        out[f.name] = row ? (raw == null ? null : String(raw)) : (f.defaultValue ?? null)
        break
      default:
        out[f.name] = row ? (raw == null ? '' : String(raw)) : (f.defaultValue ?? '')
    }
  }
  return out
}

const isEmpty = (v: unknown) => v == null || v === ''

/** 提交 payload:仅收当前可见且当前 mode 可编辑的字段;undefined 归 null */
export function collectValues(
  fields: ResolvedField[],
  values: Record<string, unknown>,
  mode: 'create' | 'edit'
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of visibleFields(fields, values)) {
    if (isFieldDisabled(f, mode)) continue
    out[f.name] = values[f.name] ?? null
  }
  return out
}

/** 必填缺失的字段 label;只查当前可见且可编辑的字段(false/0 不算空) */
export function missingRequired(
  fields: ResolvedField[],
  values: Record<string, unknown>,
  mode: 'create' | 'edit'
): string[] {
  return visibleFields(fields, values)
    .filter((f) => f.required && !isFieldDisabled(f, mode) && isEmpty(values[f.name]))
    .map((f) => f.label)
}
```

- [ ] **Step 5: 跑自检确认通过 + tsc**

```bash
cd "$WT/web" && bun app/components/synie-record-drawer/record-drawer-checks.ts && bunx tsc --noEmit
```

Expected: `record-drawer-checks ok`，tsc 无错误。

- [ ] **Step 6: Commit**

```bash
cd "$WT" && git add web/app/components/synie-record-drawer/ && git commit -m "feat: SynieRecordDrawer 纯函数层——字段解析/初值/收集/必填(bun 自检)"
```

---

### Task 2: SynieRecordDrawer 组件

**Files:**
- Create: `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx`

**Interfaces:**
- Consumes: Task 1 的全部导出；`useGridMeta`（`../synie-data-grid/meta`）；`cellText`（`../synie-data-grid/format`）；`Row`（`../synie-data-grid/types`）；`Sheet`（`@heroui-pro/react`）
- Produces（Task 4 依赖）: `SynieRecordDrawer` 组件与 `SynieRecordDrawerProps`（见下方代码）

- [ ] **Step 1: 实现组件**

创建 `web/app/components/synie-record-drawer/SynieRecordDrawer.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { parseDate } from '@internationalized/date'
import {
  Button,
  Calendar,
  DateField,
  DatePicker,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Spinner,
  Switch,
  TextField,
  toast,
} from '@heroui/react'
import { Sheet } from '@heroui-pro/react'
import { cellText } from '../synie-data-grid/format'
import { useGridMeta } from '../synie-data-grid/meta'
import type { Row } from '../synie-data-grid/types'
import {
  collectValues,
  initialValues,
  isFieldDisabled,
  missingRequired,
  resolveFields,
  visibleFields,
  type DrawerMode,
  type FieldOverride,
  type ResolvedField,
} from './fields'

export interface SynieRecordDrawerProps {
  /** 与后端 GridMeta 白名单同名,如 "sysRoles" */
  resource: string
  mode: DrawerMode
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 资源中文名,标题拼为 新增{label}/编辑{label}/{label}详情 */
  label?: string
  /** view/edit 数据源:直接用表格行数据,不按 id 重查 */
  // ponytail: 详情需要表格未取字段时再加 by-id 查询
  row?: Row | null
  exclude?: string[]
  fields?: Record<string, FieldOverride>
  /** create/edit 提交;resolve 即成功(组件关抽屉),throw 则 toast 且不关 */
  onSubmit?: (values: Record<string, unknown>, mode: 'create' | 'edit') => Promise<void>
  /** view 态 footer 显示「编辑」按钮,点击回调(页面自行切 mode) */
  onEdit?: () => void
  /** Sheet.Content 宽度样式 */
  contentClassName?: string
}

// Tailwind v4 JIT 扫不到动态拼接类名,1-12 静态映射
const COL_SPAN: Record<number, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  8: 'lg:col-span-8',
  9: 'lg:col-span-9',
  10: 'lg:col-span-10',
  11: 'lg:col-span-11',
  12: 'lg:col-span-12',
}

export function SynieRecordDrawer(props: SynieRecordDrawerProps) {
  const { resource, mode, isOpen, row, exclude, label = '', contentClassName = 'w-full lg:w-[480px]' } = props
  const meta = useGridMeta(resource)

  const fields = resolveFields(meta.data?.columns ?? [], mode, exclude, props.fields)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  // 打开/换行/换模式时重建草稿(view 不用草稿,直接读 row)。
  // props.fields/exclude 常为内联字面量,进依赖会在父级每次渲染时重置用户输入;
  // 初值只取决于列类型与行数据,故不列入。
  useEffect(() => {
    if (isOpen && mode !== 'view') {
      setValues(initialValues(resolveFields(meta.data?.columns ?? [], mode, exclude, props.fields), row))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, row, meta.data])

  const shown = visibleFields(fields, mode === 'view' ? ((row ?? {}) as Record<string, unknown>) : values)
  const title = mode === 'create' ? `新增${label}` : mode === 'edit' ? `编辑${label}` : `${label}详情`

  const save = async () => {
    if (!props.onSubmit || mode === 'view') return
    const missing = missingRequired(fields, values, mode)
    if (missing.length > 0) {
      toast.danger(`请填写:${missing.join('、')}`)
      return
    }
    setSaving(true)
    try {
      await props.onSubmit(collectValues(fields, values, mode), mode)
      props.onOpenChange(false)
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet isOpen={isOpen} onOpenChange={props.onOpenChange} placement="right">
      <Sheet.Backdrop>
        <Sheet.Content className={contentClassName}>
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{title}</Sheet.Heading>
            </Sheet.Header>
            <Sheet.Body>
              {meta.isPending ? (
                <div className="flex h-32 items-center justify-center">
                  <Spinner />
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                  {shown.map((f) => (
                    <div key={f.name} className={COL_SPAN[f.cols]}>
                      {mode === 'view' ? (
                        <ViewField field={f} row={row ?? ({ id: '' } as Row)} />
                      ) : (
                        <FieldInput
                          field={f}
                          value={values[f.name]}
                          isDisabled={isFieldDisabled(f, mode) || saving}
                          onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Sheet.Body>
            <Sheet.Footer>
              {mode === 'view' ? (
                <>
                  <Sheet.Close>
                    <Button variant="secondary">关闭</Button>
                  </Sheet.Close>
                  {props.onEdit && <Button onPress={props.onEdit}>编辑</Button>}
                </>
              ) : (
                <>
                  <Sheet.Close>
                    <Button variant="secondary" isDisabled={saving}>
                      取消
                    </Button>
                  </Sheet.Close>
                  <Button onPress={save} isPending={saving}>
                    保存
                  </Button>
                </>
              )}
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  )
}

/** view 态字段:label + 与表格同一套格式化(cellText) */
function ViewField({ field, row }: { field: ResolvedField; row: Row }) {
  const value = row[field.name]
  const text = cellText(field.col, value)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">{field.label}</span>
      <div className="text-sm">
        {field.render ? field.render(value, row) : text || <span className="text-muted">—</span>}
      </div>
    </div>
  )
}

/** 表单控件按列类型分发(filter-popover 先例);override.input 优先 */
function FieldInput({
  field,
  value,
  isDisabled,
  onChange,
}: {
  field: ResolvedField
  value: unknown
  isDisabled: boolean
  onChange: (v: unknown) => void
}) {
  if (field.input) return <>{field.input({ value, onChange, isDisabled })}</>

  switch (field.col.type) {
    case 'boolean':
      return (
        <Switch isSelected={Boolean(value)} onChange={onChange} isDisabled={isDisabled}>
          <Switch.Content className="text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            {field.label}
          </Switch.Content>
        </Switch>
      )
    case 'integer':
    case 'decimal':
      return (
        <NumberField
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null || value === '' ? NaN : Number(value)}
          onChange={(n) => onChange(Number.isFinite(n) ? n : null)}
        >
          <Label>{field.label}</Label>
          <NumberField.Group>
            <NumberField.Input placeholder={field.placeholder} />
          </NumberField.Group>
        </NumberField>
      )
    case 'date':
    case 'datetime':
      // ponytail: datetime 编辑先按日期粒度,业务需要时分秒时换带 granularity 的 DateField
      return (
        <DatePicker
          isDisabled={isDisabled}
          isRequired={field.required}
          value={typeof value === 'string' && value ? parseDate(value) : null}
          onChange={(v) => onChange(v ? v.toString() : null)}
        >
          <Label>{field.label}</Label>
          <DateField.Group fullWidth>
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label={field.label}>
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
                <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
              </Calendar.Grid>
              <Calendar.YearPickerGrid>
                <Calendar.YearPickerGridBody>
                  {({ year }) => <Calendar.YearPickerCell year={year} />}
                </Calendar.YearPickerGridBody>
              </Calendar.YearPickerGrid>
            </Calendar>
          </DatePicker.Popover>
        </DatePicker>
      )
    case 'enum':
      return (
        <Select
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null ? null : String(value)}
          onChange={(v) => onChange(v)}
        >
          <Label>{field.label}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {(field.col.enumOptions ?? []).map((o) => (
                <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                  {o.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )
    default:
      return (
        <TextField
          isDisabled={isDisabled}
          isRequired={field.required}
          value={value == null ? '' : String(value)}
          onChange={onChange}
        >
          <Label>{field.label}</Label>
          <Input placeholder={field.placeholder} />
        </TextField>
      )
  }
}
```

- [ ] **Step 2: tsc 校验**

```bash
cd "$WT/web" && bunx tsc --noEmit
```

Expected: 无错误。若 HeroUI 组件 props 报类型错（如 Select 的 Label 位置、DatePicker value 类型），用 `heroui-pro` MCP 的 `get_component_docs` 查对应组件（select/date-picker/text-field/switch/number-field/sheet）修正用法，不要自造 props。

- [ ] **Step 3: Commit**

```bash
cd "$WT" && git add web/app/components/synie-record-drawer/SynieRecordDrawer.tsx && git commit -m "feat: SynieRecordDrawer 组件——Sheet 三态抽屉+12 栅格+按类型分发控件"
```

---

### Task 3: SynieDataGrid 行菜单加「查看」

**Files:**
- Modify: `web/app/components/synie-data-grid/use-grid-actions.tsx`（opts 类型 + rowMenuFor）
- Modify: `web/app/components/synie-data-grid/SynieDataGrid.tsx`（props + useGridActions 接线）

**Interfaces:**
- Produces（Task 4 依赖）: `SynieDataGridProps.onView?: (row: Row) => void`——传了就在行内菜单第一项显示「查看」，无 capability 门控（能见表格行即有 read 权限）

- [ ] **Step 1: use-grid-actions.tsx 加 onView**

`useGridActions` 的 opts 参数类型中，`onCreate?: () => void` 之前加一行：

```ts
  onView?: (row: Row) => void
```

`rowMenuFor` 数组开头（`can('update') && opts.onEdit` 条目之前）加：

```ts
    ...(opts.onView
      ? [{ key: 'view', label: '查看', isDanger: false, run: () => opts.onView!(row) }]
      : []),
```

- [ ] **Step 2: SynieDataGrid.tsx 接线**

`SynieDataGridProps` 中 `onCreate?: () => void` 之前加：

```ts
  /** 传了就在行内菜单第一项显示「查看」(打开详情抽屉) */
  onView?: (row: Row) => void
```

`useGridActions({...})` 调用中 `onCreate: props.onCreate,` 之前加：

```ts
    onView: props.onView,
```

- [ ] **Step 3: 校验 + Commit**

```bash
cd "$WT/web" && bunx tsc --noEmit && bun app/components/synie-data-grid/grid-checks.ts
cd "$WT" && git add web/app/components/synie-data-grid/ && git commit -m "feat: SynieDataGrid 行菜单增加「查看」动作(onView)"
```

Expected: tsc 无错误，`grid-checks ok`。

---

### Task 4: roles 试点页迁移

**Files:**
- Modify: `web/app/routes/_app/system/roles.tsx`（整文件重写）

**Interfaces:**
- Consumes: Task 2 `SynieRecordDrawer`、Task 3 `onView`
- Produces: 无（叶子页面）

- [ ] **Step 1: 重写 roles.tsx**

整文件替换为：

```tsx
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/roles')({
  component: RolesPage,
})

const CREATE_ROLE = `
  mutation ($input: CreateSysRoleInput!) {
    createSysRole(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ROLE = `
  mutation ($id: ID!, $input: UpdateSysRoleInput!) {
    updateSysRole(id: $id, input: $input) { result { id } errors { message } }
  }
`

function RolesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">角色权限</h1>
      <p className="mt-2 text-sm text-ink-500">管理系统角色与其权限授权。</p>

      <div className="mt-6">
        <SynieDataGrid
          key={reloadKey}
          resource="sysRoles"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="sysRoles"
        label="角色"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '如 purchaser' },
          name: { required: true, placeholder: '如 采购管理员' },
          enabled: { defaultValue: true },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          // 更新/创建两支返回不同字段名,各自取 errors 而非 Object.values(data)[0](那样会退化为 any)
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createSysRole: { errors: { message: string }[] | null } }>(CREATE_ROLE, {
              input: values,
            })
            errors = data.createSysRole.errors
          } else {
            const data = await gqlFetch<{ updateSysRole: { errors: { message: string }[] | null } }>(UPDATE_ROLE, {
              id: drawer!.row!.id,
              input: values,
            })
            errors = data.updateSysRole.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '角色已创建' : '角色已更新')
          setReloadKey((k) => k + 1) // 触发 SynieDataGrid 重挂载刷新(跟进项:第二个使用页出现时暴露 refetch)
        }}
      />
    </>
  )
}
```

要点：成功 toast 由页面发（文案页面才知道），组件负责关抽屉；`onSubmit` throw 时组件 toast「保存失败」且不关抽屉，与旧行为一致。

- [ ] **Step 2: 校验 + Commit**

```bash
cd "$WT/web" && bunx tsc --noEmit
cd "$WT" && git add web/app/routes/_app/system/roles.tsx && git commit -m "refactor: roles 页迁移 SynieRecordDrawer——增/改/查三态抽屉"
```

Expected: tsc 无错误。

---

### Task 5: 浏览器实测三态

**Files:** 无新文件（发现问题就地修，随修随提交）

- [ ] **Step 1: 起服务**

后端（backend 无改动，直接用主 checkout，省去 worktree 重编译）：

```bash
cd /home/zyan/code/synie/backend
export PATH="$HOME/.elixir-install/installs/elixir/1.20.2-otp-28/bin:$HOME/.elixir-install/installs/otp/28.4/bin:$PATH"
mix phx.server
```

前端（worktree，后台跑）：

```bash
cd "$WT/web" && bun run dev
```

Expected: 后端 4000，前端 dev server 输出端口（vite 代理 `/graphql` → 4000）。

- [ ] **Step 2: 走查三态（playwright MCP）**

打开 `http://localhost:<dev端口>/system/roles`，登录 admin/admin123，逐项确认：

1. 行菜单第一项「查看」→ 右侧抽屉标题「角色详情」，字段值与表格行一致，含 id/创建时间等系统字段；footer「关闭」+「编辑」。
2. 详情点「编辑」→ 切「编辑角色」，code 输入框 disabled 且显示原值，name/enabled 可改。
3. 工具栏「新增」→「新增角色」，enabled 默认开启（defaultValue: true）；直接点保存 → toast「请填写:角色编码、角色名称」，抽屉不关。
4. 填 code/name 保存 → toast「角色已创建」，抽屉关闭，表格出现新行。
5. 编辑该行改 name 保存 → toast「角色已更新」，表格刷新。
6. 删除测试行（行菜单「删除」清理数据）。
7. 视口缩到 375×812 → 抽屉全宽、字段单列。
8. 浏览器 console 无红色报错（RAC 受控组件警告为零容忍）。

- [ ] **Step 3: 最终闸门 + 收尾提交**

```bash
cd "$WT/web" && bunx tsc --noEmit \
  && bun app/components/synie-record-drawer/record-drawer-checks.ts \
  && bun app/components/synie-data-grid/grid-checks.ts
```

Expected: 全绿。有走查修复则一并提交（提交信息如 `fix: 记录抽屉走查修复——<问题>`）。
