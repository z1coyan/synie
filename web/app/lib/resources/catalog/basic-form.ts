/**
 * 从 ResourceDocument v2 派生 SynieRecordDrawer 可用的静态表单配置。
 * expand/migrate：Basic Form renderer 消费 Catalog，不再在页面重复 label/required/edit。
 */
import type {
  BasicFormFieldPlacement,
  FieldDocument,
  ResourceDocument,
} from '@synie/shared'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'

export interface BasicFormDrawerProps {
  label: string
  exclude: string[]
  fields: Record<string, FieldOverride>
}

function placementMap(
  document: ResourceDocument,
): Map<string, BasicFormFieldPlacement> {
  const map = new Map<string, BasicFormFieldPlacement>()
  if (document.form.kind !== 'basic') return map
  const take = (items: BasicFormFieldPlacement[] | undefined) => {
    if (!items) return
    for (const p of items) map.set(p.field, p)
  }
  take(document.form.layout.fields)
  for (const s of document.form.layout.sections ?? []) take(s.fields)
  for (const t of document.form.layout.tabs ?? []) {
    take(t.fields)
    for (const s of t.sections ?? []) take(s.fields)
  }
  return map
}

function fieldConfig(
  field: FieldDocument,
  placement: BasicFormFieldPlacement | undefined,
): FieldOverride {
  const config: FieldOverride = {}
  if (field.input.create === 'required') config.required = true
  if (field.input.create === 'forbidden' && field.input.update === 'forbidden') {
    config.edit = 'readOnly'
  } else if (field.input.update === 'forbidden' && field.input.create !== 'forbidden') {
    config.edit = 'createOnly'
  }
  if (placement?.placeholder) config.placeholder = placement.placeholder
  if (field.kind === 'enum' || field.kind === 'enumArray') {
    // enum 由 grid meta / 字段类型驱动；此处不重复 options
  }
  if (field.kind === 'reference' && field.filterState) {
    config.remote = { filterState: field.filterState as never }
  }
  if (field.kind === 'json' || field.kind === 'polymorphicReference') {
    // Basic Form 不支持：调用方应 fail-closed，不退化为文本
    throw new Error(
      `Basic Form 不支持字段 kind=${field.kind}（${field.name}）；请使用 Presentation Extension`,
    )
  }
  if (field.kind === 'reference' && field.targetUnavailable) {
    throw new Error(
      `Basic Form 外键 ${field.name} 目标不可读，不得渲染可编辑 ID`,
    )
  }
  return config
}

/**
 * 将 catalog 文档转为 drawer 静态 props。
 * form.kind 必须是 basic；否则抛错（extension/none 不走本路径）。
 */
export function basicFormDrawerProps(document: ResourceDocument): BasicFormDrawerProps {
  if (document.form.kind !== 'basic') {
    throw new Error(
      `资源「${document.name}」form.kind=${document.form.kind}，不能使用 Basic Form 渲染器`,
    )
  }

  const placements = placementMap(document)
  const placedNames = new Set(placements.keys())
  const fields: Record<string, FieldOverride> = {}
  const exclude: string[] = []

  for (const field of document.fields) {
    if (field.visibility === 'writeOnly') {
      // write-only 可进表单，但不在 list；若布局未放则排除
      if (!placedNames.has(field.name)) {
        exclude.push(field.name)
        continue
      }
    }
    if (field.input.create === 'forbidden' && field.input.update === 'forbidden') {
      exclude.push(field.name)
      continue
    }
    if (!placedNames.has(field.name)) {
      // 未布局的可写字段：默认排除（布局是权威）
      exclude.push(field.name)
      continue
    }
    fields[field.name] = fieldConfig(field, placements.get(field.name))
  }

  // 确保布局中的字段都有配置
  for (const name of placedNames) {
    if (!fields[name]) {
      const field = document.fields.find((f) => f.name === name)
      if (!field) throw new Error(`布局字段 ${name} 不在 document.fields 中`)
      fields[name] = fieldConfig(field, placements.get(name))
    }
  }

  return {
    label: document.label,
    exclude: [...new Set(exclude)],
    fields,
  }
}

/** 币种 RecordFormCodec：runtime form values → API Create/Update */
export interface CurrencyFormValues {
  name?: string
  isoCode?: string
  symbol?: string | null
  active?: boolean
}

export interface CurrencyCreateInput {
  name: string
  isoCode: string
  symbol?: string | null
  active?: boolean
}

export interface CurrencyUpdateInput {
  name?: string
  symbol?: string | null
  active?: boolean
}

export function decodeCurrencyCreate(values: Record<string, unknown>): CurrencyCreateInput {
  const name = String(values.name ?? '').trim()
  const isoCode = String(values.isoCode ?? '').trim()
  if (!name) throw new Error('货币名称必填')
  if (!isoCode) throw new Error('ISO 编码必填')
  return {
    name,
    isoCode,
    symbol: values.symbol == null || values.symbol === '' ? null : String(values.symbol),
    active: values.active === undefined ? true : Boolean(values.active),
  }
}

export function decodeCurrencyUpdate(values: Record<string, unknown>): CurrencyUpdateInput {
  const out: CurrencyUpdateInput = {}
  if (values.name !== undefined) out.name = String(values.name).trim()
  if (values.symbol !== undefined) {
    out.symbol = values.symbol == null || values.symbol === '' ? null : String(values.symbol)
  }
  if (values.active !== undefined) out.active = Boolean(values.active)
  // isoCode 创建后不可改：即使表单误传也剔除
  return out
}
