import type { FieldDocument, ResourceDocument } from '@synie/shared'
import { allResourceDocuments } from '../../catalog/all'
import type { PlaceholderSet, PrintField, PrintLoop, PrintResourceCatalog } from './types'
import { uniqueSorted } from './xlsx'

export const PRINT_RESOURCE_DEFINITIONS = Object.freeze({
  'sales.order': {
    head: 'salOrders',
    loops: { items: 'salOrderItems' },
  },
  'mfg.work_order': {
    head: 'mfgWorkOrders',
    loops: {
      components: 'mfgWorkOrderComponents',
      routes: 'mfgWorkOrderRoutes',
      byproducts: 'mfgWorkOrderByproducts',
    },
  },
} as const)

export type PrintableResource = keyof typeof PRINT_RESOURCE_DEFINITIONS

const TECHNICAL_FIELDS = new Set(['id', 'insertedAt', 'updatedAt'])

export function printableResources(): PrintableResource[] {
  return Object.keys(PRINT_RESOURCE_DEFINITIONS).sort() as PrintableResource[]
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function printableScalar(field: FieldDocument): boolean {
  return !TECHNICAL_FIELDS.has(field.name) &&
    field.visibility === 'readable' &&
    field.kind !== 'uuid' &&
    field.kind !== 'reference' &&
    field.kind !== 'polymorphicReference'
}

function referencePrefix(field: FieldDocument): string {
  return snakeCase(('relation' in field ? field.relation : undefined) ?? field.name.replace(/Id$/, ''))
}

function targetFields(target: ResourceDocument, prefix: string, names: Set<string>): void {
  for (const field of target.fields) {
    if (!printableScalar(field)) continue
    names.add(`${prefix}.${snakeCase(field.name)}`)
  }
}

function deriveFields(resource: ResourceDocument): PrintField[] {
  const names = new Set<string>()
  for (const field of resource.fields) {
    if (printableScalar(field)) {
      names.add(snakeCase(field.name))
      continue
    }
    if (TECHNICAL_FIELDS.has(field.name) || field.visibility !== 'readable') continue
    if (field.kind === 'reference') {
      const target = allResourceDocuments[field.targetResource]
      if (!target) throw new Error(`${resource.name}.${field.name} 指向未知 Catalog 资源`)
      targetFields(target, referencePrefix(field), names)
    } else if (field.kind === 'polymorphicReference') {
      const prefix = referencePrefix(field)
      for (const variant of field.variants) {
        const target = allResourceDocuments[variant.resource]
        if (!target) throw new Error(`${resource.name}.${field.name} 指向未知 Catalog 资源`)
        targetFields(target, prefix, names)
      }
    }
  }
  return [...names].sort().map((name) => ({ name, label: name }))
}

function assertDefinition(resource: PrintableResource): PrintResourceCatalog {
  const definition = PRINT_RESOURCE_DEFINITIONS[resource]
  const head = allResourceDocuments[definition.head]
  if (!head || head.permissionPrefix !== resource) {
    throw new Error(`${resource} 打印头与 sealed Catalog 不一致`)
  }
  for (const capability of ['print', 'export', 'batch_print']) {
    if (!head.capabilities.includes(capability)) {
      throw new Error(`${resource} 缺少 ${capability} capability`)
    }
  }
  const loops: PrintLoop[] = Object.entries(definition.loops).map(([name, childName]) => {
    const child = allResourceDocuments[childName]
    if (!child || child.permissionPrefix !== resource) {
      throw new Error(`${resource}.${name} 与 sealed Catalog 不一致`)
    }
    return { name, label: name, fields: deriveFields(child) }
  })
  return { resource, fields: deriveFields(head), loops: loops.sort((a, b) => a.name.localeCompare(b.name)) }
}

const CATALOG = new Map(printableResources().map((resource) => [resource, assertDefinition(resource)]))

function clone(value: PrintResourceCatalog): PrintResourceCatalog {
  return {
    resource: value.resource,
    fields: value.fields.map((field) => ({ ...field })),
    loops: value.loops.map((loop) => ({ ...loop, fields: loop.fields.map((field) => ({ ...field })) })),
  }
}

export function fieldCatalog(resource: string): PrintResourceCatalog | null {
  const value = CATALOG.get(resource as PrintableResource)
  return value ? clone(value) : null
}

export function validatePlaceholders(resource: string, placeholders: PlaceholderSet): void {
  const catalog = CATALOG.get(resource as PrintableResource)
  if (!catalog) throw new Error(`不支持的资源类型 ${resource}`)
  const head = new Set(catalog.fields.map((field) => field.name))
  const loops = new Map(catalog.loops.map((loop) => [loop.name, new Set(loop.fields.map((field) => field.name))]))
  const unknown: string[] = []
  for (const name of placeholders.fields) if (!head.has(name)) unknown.push(name)
  for (const [prefix, suffixes] of Object.entries(placeholders.nested)) {
    const fields = loops.get(prefix)
    for (const suffix of suffixes) {
      if (fields) {
        if (suffix !== '_seq' && !fields.has(suffix)) unknown.push(`${prefix}.${suffix}`)
      } else if (!head.has(`${prefix}.${suffix}`)) {
        unknown.push(`${prefix}.${suffix}`)
      }
    }
  }
  if (unknown.length) throw new Error(`模板含未知字段: ${uniqueSorted(unknown).join(', ')}`)
}
