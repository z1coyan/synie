/**
 * 编号字段目录：自 meta.Registry 派生（对齐 printing/catalog.ts 先例）。
 * 声明 numbering 的资源按字段声明顺序产出目录：普通字段直取，
 * 普通 fk 一层展开为 lookup 字段，多态 fk 保留原始 ID 列，
 * 并展开各变体共有的标量字段（如 party.code，取号时按判别列选表）。
 * DB 中的编号规则按 (prefix, path) 引用目录字段，prefix 恒等于 permissionPrefix。
 */
import type { Registry } from '../meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '../meta/types.ts'

const TECHNICAL_FIELDS = new Set(['id', 'inserted_at', 'updated_at'])

export interface NumberableField {
  path: string
  label: string
  type: string
}

export interface NumberableResource {
  prefix: string
  grid: string
  fields: NumberableField[]
}

export interface PolyLookupVariant {
  /** 判别值（与 meta variant.value 一致；取号时大小写不敏感匹配） */
  value: string
  table: string
  valueColumn: string
}

export interface CatalogField {
  path: string
  label: string
  type: string
  sourceField: string
  lookup?: { table: string; valueColumn: string }
  /** 多态 fk 展开：按判别列选目标表再 lookup */
  polyLookup?: {
    discriminatorField: string
    variants: PolyLookupVariant[]
  }
}

export interface CatalogResource {
  prefix: string
  grid: string
  fields: CatalogField[]
  byPath: Map<string, CatalogField>
}

export function buildNumberingCatalog(registry: Registry): {
  publicResources: () => NumberableResource[]
  resource: (prefix: string) => CatalogResource | undefined
} {
  if (!registry) throw new Error('编号字段目录需要 meta.Registry')

  const byPrefix = new Map<string, CatalogResource>()
  const resources: CatalogResource[] = []

  for (const meta of registry.list()) {
    if (!meta.numbering) continue
    const prefix = meta.permissionPrefix
    const existing = byPrefix.get(prefix)
    if (existing) {
      throw new Error(
        `编号字段目录重复资源: ${prefix}（${existing.grid} 与 ${meta.name} 同时声明 numbering）`,
      )
    }
    const fields = deriveFields(registry, meta)
    if (fields.length === 0) {
      throw new Error(`Meta 资源 ${meta.name} 声明了 numbering 但派生不出编号字段`)
    }
    const byPath = new Map<string, CatalogField>()
    for (const field of fields) {
      if (byPath.has(field.path)) {
        throw new Error(`编号字段目录重复路径: ${prefix}/${field.path}`)
      }
      byPath.set(field.path, field)
    }
    const resource: CatalogResource = { prefix, grid: meta.name, fields, byPath }
    byPrefix.set(prefix, resource)
    resources.push(resource)
  }

  return {
    publicResources() {
      return resources.map((resource) => ({
        prefix: resource.prefix,
        grid: resource.grid,
        fields: resource.fields.map((f) => ({ path: f.path, label: f.label, type: f.type })),
      }))
    },
    resource(prefix: string) {
      return byPrefix.get(prefix)
    },
  }
}

export type NumberingCatalog = ReturnType<typeof buildNumberingCatalog>

function deriveFields(registry: Registry, resource: ResourceMeta): CatalogField[] {
  const fields: CatalogField[] = []
  for (const field of resource.fields) {
    if (TECHNICAL_FIELDS.has(field.name) || field.sensitive || field.calculated || field.printOnly) {
      continue
    }
    if (field.ref) {
      if (field.ref.variants && field.ref.variants.length > 0) {
        // 多态 fk：保留原始 ID 列 + 各变体共有标量字段（party.code 等）
        fields.push({
          path: field.name,
          label: field.label,
          type: 'fk',
          sourceField: field.dbColumn,
        })
        derivePolyLookupFields(registry, resource, field, fields)
        continue
      }
      if (!field.ref.resource) continue
      const target = registry.get(field.ref.resource)
      if (!target) {
        throw new Error(
          `Meta 资源 ${resource.name} 字段 ${field.name} 的编号关联指向未知资源: ${field.ref.resource}`,
        )
      }
      deriveLookupFields(field, target, fields)
      continue
    }
    if (field.type === 'fk' || field.name.endsWith('_id')) continue
    fields.push({
      path: field.name,
      label: field.label,
      type: numberingType(field),
      sourceField: field.dbColumn,
    })
  }
  return fields
}

function deriveLookupFields(field: FieldMeta, target: ResourceMeta, out: CatalogField[]): void {
  const prefix = refPrefix(field)
  for (const targetField of target.fields) {
    if (!isNumberableScalar(targetField)) continue
    out.push({
      path: `${prefix}.${targetField.name}`,
      label: `${field.label}·${targetField.label}`,
      type: numberingType(targetField),
      sourceField: field.dbColumn,
      lookup: { table: target.table, valueColumn: targetField.dbColumn },
    })
  }
}

/**
 * 多态 fk：对所有变体目标资源共有的标量字段产出 polyLookup 目录项。
 * 取号时按判别列值选表（判别值大小写不敏感）。
 */
function derivePolyLookupFields(
  registry: Registry,
  resource: ResourceMeta,
  field: FieldMeta,
  out: CatalogField[],
): void {
  const variants = field.ref?.variants
  const discApi = field.ref?.discriminator
  if (!variants?.length || !discApi) return

  const discMeta = resource.fields.find((f) => f.apiName === discApi || f.name === discApi)
  if (!discMeta) {
    throw new Error(
      `Meta 资源 ${resource.name} 多态字段 ${field.name} 的判别列 ${discApi} 不存在`,
    )
  }

  const resolved = variants.map((variant) => {
    const target = registry.get(variant.resource)
    if (!target) {
      throw new Error(
        `Meta 资源 ${resource.name} 字段 ${field.name} 的编号关联指向未知资源: ${variant.resource}`,
      )
    }
    return { value: variant.value, target }
  })

  const scalarLists = resolved.map((r) => r.target.fields.filter(isNumberableScalar))
  const firstScalars = scalarLists[0] ?? []
  const prefix = refPrefix(field)

  for (const candidate of firstScalars) {
    const perVariant: Array<{ value: string; table: string; valueColumn: string; label: string }> =
      []
    let type: string | null = null
    let ok = true
    for (let i = 0; i < resolved.length; i++) {
      const match = scalarLists[i]!.find((f) => f.name === candidate.name)
      if (!match) {
        ok = false
        break
      }
      const t = numberingType(match)
      if (type == null) type = t
      else if (type !== t) {
        ok = false
        break
      }
      perVariant.push({
        value: resolved[i]!.value,
        table: resolved[i]!.target.table,
        valueColumn: match.dbColumn,
        label: match.label,
      })
    }
    if (!ok || type == null) continue

    const labels = perVariant.map((v) => v.label)
    const labelSuffix = labels.every((l) => l === labels[0])
      ? labels[0]!
      : commonPolyLabel(candidate.name)

    out.push({
      path: `${prefix}.${candidate.name}`,
      label: `${field.label}·${labelSuffix}`,
      type,
      sourceField: field.dbColumn,
      polyLookup: {
        discriminatorField: discMeta.dbColumn,
        variants: perVariant.map((v) => ({
          value: v.value,
          table: v.table,
          valueColumn: v.valueColumn,
        })),
      },
    })
  }
}

function isNumberableScalar(field: FieldMeta): boolean {
  if (
    TECHNICAL_FIELDS.has(field.name) ||
    field.sensitive ||
    field.calculated ||
    field.printOnly
  ) {
    return false
  }
  if (field.ref || field.type === 'fk' || field.name.endsWith('_id')) return false
  return true
}

/** 多态变体标签不一致时的共用中文后缀 */
function commonPolyLabel(fieldName: string): string {
  switch (fieldName) {
    case 'code':
      return '编号'
    case 'name':
      return '名称'
    case 'short_name':
      return '简称'
    default:
      return fieldName
  }
}

/** json 列取号时按字符串渲染（与旧目录 wire 契约一致） */
function numberingType(field: FieldMeta): string {
  return field.type === 'json' ? 'string' : field.type
}

function refPrefix(field: FieldMeta): string {
  if (field.ref?.relation) return snakeCase(field.ref.relation)
  return field.dbColumn.replace(/_id$/, '')
}

function snakeCase(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const r = value[index]!
    if (r >= 'A' && r <= 'Z') {
      if (index > 0) result += '_'
      result += r.toLowerCase()
    } else {
      result += r
    }
  }
  return result
}
