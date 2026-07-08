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
