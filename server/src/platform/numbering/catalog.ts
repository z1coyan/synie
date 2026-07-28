import numberablesJson from './numberables.json'

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

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

export function loadCatalog(): {
  publicResources: () => NumberableResource[]
  resource: (prefix: string) => CatalogResource | undefined
} {
  const raw = numberablesJson as Array<{
    prefix: string
    grid: string
    fields: CatalogField[]
  }>
  const byPrefix = new Map<string, CatalogResource>()
  const resources: CatalogResource[] = []

  for (const item of raw) {
    if (!item.prefix || !item.grid) throw new Error('编号字段目录存在空资源')
    const byPath = new Map<string, CatalogField>()
    for (const field of item.fields) {
      if (!field.path || !field.label || !field.type || !IDENTIFIER_RE.test(field.sourceField)) {
        throw new Error(`编号字段目录存在非法字段: ${JSON.stringify(field)}`)
      }
      if (
        field.lookup &&
        (!IDENTIFIER_RE.test(field.lookup.table) || !IDENTIFIER_RE.test(field.lookup.valueColumn))
      ) {
        throw new Error(`编号字段目录存在非法查询列: ${JSON.stringify(field)}`)
      }
      if (byPath.has(field.path)) {
        throw new Error(`编号字段目录重复路径: ${item.prefix}/${field.path}`)
      }
      byPath.set(field.path, field)
    }
    if (byPrefix.has(item.prefix)) throw new Error(`编号字段目录重复资源: ${item.prefix}`)
    const resource: CatalogResource = {
      prefix: item.prefix,
      grid: item.grid,
      fields: item.fields,
      byPath,
    }
    byPrefix.set(item.prefix, resource)
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

export type NumberingCatalog = ReturnType<typeof loadCatalog>
