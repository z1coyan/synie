import type { ReactNode } from 'react'
import type { GridColumnMeta, Row } from '../synie-data-grid/types'
import type { RemoteSourceConfig } from '../synie-remote-select/remote-query'

export type DrawerMode = 'view' | 'create' | 'edit'
export type FieldEdit = 'editable' | 'createOnly' | 'readOnly'

export interface FieldInputProps {
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
  /** 当前表单完整草稿值(而非仅本字段),供联动控件读取兄弟字段(如按 partyType 切换 partyId 数据源) */
  values: Record<string, unknown>
  /** 向表单草稿并入补丁(view 态 no-op):选段带出多字段、跨字段联动计算用 */
  patchValues: (patch: Record<string, unknown>) => void
}

export interface FieldOverride {
  label?: string
  /** 表单内排序权重,默认为 meta 列序号;给负值可提到最前(如公司字段) */
  order?: number
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
  /** 值变更联动:返回的补丁并入表单草稿(如 partyType 变更时清空 partyId) */
  effects?: (value: unknown) => Record<string, unknown> | void
  /** fk 控件形态:默认 'select'(下拉);'dialog' 弹窗表格选择 */
  picker?: 'select' | 'dialog'
  /** fk 数据源定制(searchFields/renderItem/renderValue/filter…);resource 缺省取列 ref */
  remote?: Partial<RemoteSourceConfig>
}

export interface ResolvedField {
  col: GridColumnMeta
  order: number
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
  effects?: (value: unknown) => Record<string, unknown> | void
  picker?: 'select' | 'dialog'
  remote?: Partial<RemoteSourceConfig>
}

/** 时间戳系统字段:view 显示,create/edit 剔除;id 三态都不显示(与表格过滤 id 对齐)。下轮 GridMeta 扩表单元数据后由后端 accept 列表推导 */
const SYSTEM_FIELDS = ['insertedAt', 'updatedAt']

export function resolveFields(
  columns: GridColumnMeta[],
  mode: DrawerMode,
  exclude: string[] = [],
  overrides: Record<string, FieldOverride> = {}
): ResolvedField[] {
  const resolved = columns
    .filter((c) => c.name !== 'id' && !exclude.includes(c.name))
    .filter((c) => mode === 'view' || !SYSTEM_FIELDS.includes(c.name))
    .map((c, i) => {
      const o = overrides[c.name] ?? {}
      return {
        order: o.order ?? i,
        col: c,
        name: c.name,
        label: o.label ?? c.label,
        // 非整数四舍五入,下界 1、上限 12(直接写死 col-span 类名,越界会漏渲染栅格)
        // 时间戳系统字段默认半宽:创建/更新时间在桌面并排一行
        cols: Math.min(12, Math.max(1, Math.round(o.cols ?? (SYSTEM_FIELDS.includes(c.name) ? 6 : 12)))),
        required: o.required ?? false,
        edit: o.edit ?? 'editable',
        placeholder: o.placeholder,
        defaultValue: o.defaultValue,
        visible: o.visible,
        render: o.render,
        input: o.input,
        effects: o.effects,
        picker: o.picker,
        remote: o.remote,
      }
    })
  // sort 稳定:order 同值时保持 meta 列序
  return resolved.sort((a, b) => a.order - b.order)
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
        // DatePicker(day 粒度)只吃 YYYY-MM-DD
        out[f.name] = row ? (raw ? String(raw).slice(0, 10) : null) : (f.defaultValue ?? null)
        break
      case 'datetime':
        // ISO UTC → 本地 YYYY-MM-DDTHH:mm:ss(DatePicker second 粒度编辑);提交时转回 UTC
        out[f.name] = row ? toLocalDateTime(raw) : (f.defaultValue ?? null)
        break
      case 'enum':
      case 'fk':
        // fk 值语义同 enum:id 串或 null,空不得归一为空串(GraphQL uuid 不吃空串)
        out[f.name] = row ? (raw == null ? null : String(raw)) : (f.defaultValue ?? null)
        break
      default:
        out[f.name] = row ? (raw == null ? '' : String(raw)) : (f.defaultValue ?? '')
    }
  }
  return out
}

/** ISO UTC 串 → 本地时区 YYYY-MM-DDTHH:mm:ss(@internationalized/date 的 CalendarDateTime 形态);非法回落 null */
function toLocalDateTime(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 纯空格视为空；false/0 不算空
const isEmpty = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')

/** 提交 payload:仅收当前可见且当前 mode 可编辑的字段;undefined 归 null */
export function collectValues(
  fields: ResolvedField[],
  values: Record<string, unknown>,
  mode: 'create' | 'edit'
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of visibleFields(fields, values)) {
    if (isFieldDisabled(f, mode)) continue
    const v = values[f.name] ?? null
    if (f.col.type === 'datetime' && typeof v === 'string' && v !== '') {
      // 草稿是本地 YYYY-MM-DDTHH:mm:ss,转回 ISO UTC 提交(与 initialValues 的 toLocalDateTime 互逆)
      const d = new Date(v)
      out[f.name] = Number.isNaN(d.getTime()) ? null : d.toISOString()
      continue
    }
    // fk 全裁剪退化 TextField 被清空时草稿是 '' 而非 null;GraphQL uuid 类型不吃空串,归 null
    out[f.name] = f.col.type === 'fk' && v === '' ? null : v
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
