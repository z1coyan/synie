/**
 * 编号字段目录：自 meta.Registry 派生（对齐 printing/catalog.ts 先例）。
 * 声明 numbering 的资源按字段声明顺序产出目录：普通字段直取，
 * 普通 fk 一层展开为 lookup 字段，多态 fk 保留原始 ID 列。
 * DB 中的编号规则按 (prefix, path) 引用目录字段，派生结果须保持旧目录超集
 * （见 catalog.test.ts 特征化测试）。
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

export interface CatalogField {
  path: string
  label: string
  type: string
  sourceField: string
  lookup?: { table: string; valueColumn: string }
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
    // prefix 缺省取 permissionPrefix；DB 规则绑旧串未迁移时可对象形态显式钉住（如 invMaterials）
    const prefix =
      typeof meta.numbering === 'object' && meta.numbering.prefix
        ? meta.numbering.prefix
        : meta.permissionPrefix
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
        // 多态 fk：目标表随判别值变化，无法静态 lookup，保留原始 ID 列
        fields.push({
          path: field.name,
          label: field.label,
          type: 'fk',
          sourceField: field.dbColumn,
        })
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
    if (
      TECHNICAL_FIELDS.has(targetField.name) ||
      targetField.sensitive ||
      targetField.calculated ||
      targetField.printOnly
    ) {
      continue
    }
    if (targetField.ref || targetField.type === 'fk' || targetField.name.endsWith('_id')) {
      continue
    }
    out.push({
      path: `${prefix}.${targetField.name}`,
      label: `${field.label}·${targetField.label}`,
      type: numberingType(targetField),
      sourceField: field.dbColumn,
      lookup: { table: target.table, valueColumn: targetField.dbColumn },
    })
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
