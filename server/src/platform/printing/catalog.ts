/**
 * 打印字段目录：自 meta.Registry 派生。
 * 对齐 server-go platform/printing/catalog.go。
 */
import { ApiError } from '../http/errors.ts'
import type { Registry } from '../meta/registry.ts'
import type { FieldMeta, ResourceMeta } from '../meta/types.ts'
import type { PlaceholderSet, PrintField, PrintLoop, PrintResourceCatalog } from './types.ts'
import { uniqueSorted } from './xlsx.ts'

const TECHNICAL_FIELDS = new Set(['id', 'inserted_at', 'updated_at'])

export function createFieldCatalog(registry: Registry) {
  if (!registry) throw new Error('打印字段目录需要 meta.Registry')

  const byResource = new Map<string, PrintResourceCatalog>()
  /** 打印前缀 → 打印头的 Meta 资源名：路由据此把客户端 prefix 收敛到 sealed registry */
  const metaNameByPrefix = new Map<string, string>()
  const resourceNames: string[] = []

  for (const head of printHeads(registry)) {
    const definition: PrintResourceCatalog = {
      resource: head.permissionPrefix,
      fields: deriveFields(registry, head),
      loops: [],
    }
    for (const declared of head.printLoops ?? []) {
      const target = registry.get(declared.resource)
      if (!target) {
        throw new Error(
          `打印循环区 ${head.name}.${declared.name} 指向未知 Meta 资源: ${declared.resource}`,
        )
      }
      const loop: PrintLoop = {
        name: declared.name,
        label: declared.name,
        fields: deriveFields(registry, target),
        nestedLoops: (target.printLoops ?? []).map((n) => n.name).sort(),
      }
      definition.loops.push(loop)
    }
    definition.loops.sort((a, b) => a.name.localeCompare(b.name))
    byResource.set(definition.resource, definition)
    metaNameByPrefix.set(definition.resource, head.name)
    resourceNames.push(definition.resource)
  }
  resourceNames.sort()

  function resources(): string[] {
    return [...resourceNames]
  }

  /**
   * 打印前缀 → sealed registry 的资源名（未收录返回 undefined）。
   * 打印是「请求形态派生动作码」（spec S9）：路由先经此把客户端 prefix 解析成
   * 目录内资源，再派生动作走 guard——杜绝客户端提供任意 prefix 的路径。
   */
  function resourceNameOf(prefix: string): string | undefined {
    return metaNameByPrefix.get(prefix)
  }

  function get(resource: string): PrintResourceCatalog | undefined {
    const definition = byResource.get(resource)
    return definition ? clonePrintResourceCatalog(definition) : undefined
  }

  function validatePlaceholders(resource: string, placeholders: PlaceholderSet): void {
    const definition = byResource.get(resource)
    if (!definition) {
      throw ApiError.validation(`不支持的资源类型 ${resource}`, {
        resource: ['不在打印字段目录中'],
      })
    }
    const head = fieldSet(definition.fields)
    const loops = new Map(definition.loops.map((loop) => [loop.name, loop]))

    const unknownHead: string[] = []
    for (const name of placeholders.fields) {
      if (!head.has(name)) unknownHead.push(name)
    }
    const unknownLoop: string[] = []
    const deep: string[] = []
    const nestedLoop: string[] = []
    for (const [prefix, suffixes] of Object.entries(placeholders.nested)) {
      const loop = loops.get(prefix)
      if (loop) {
        const allowed = fieldSet(loop.fields)
        allowed.add('_seq')
        const nestedNames = new Set(loop.nestedLoops ?? [])
        for (const suffix of suffixes) {
          const first = firstSegment(suffix)
          if (nestedNames.has(first)) {
            nestedLoop.push(`${prefix}.${first}`)
          } else if (!allowed.has(suffix)) {
            unknownLoop.push(`${prefix}.${suffix}`)
          }
        }
        continue
      }
      for (const suffix of suffixes) {
        const full = `${prefix}.${suffix}`
        if (suffix.includes('.')) {
          deep.push(full)
        } else if (!head.has(full)) {
          unknownHead.push(full)
        }
      }
    }

    const parts: string[] = []
    appendErrorPart(parts, '未知头字段', unknownHead)
    appendErrorPart(parts, '未知循环区字段', unknownLoop)
    appendErrorPart(parts, '关联路径只支持一层', deep)
    appendErrorPart(parts, '不支持嵌套循环', nestedLoop)
    if (parts.length === 0) return
    const message = parts.join('；')
    throw ApiError.validation(message, { fileId: [message] })
  }

  return { resources, resourceNameOf, get, validatePlaceholders }
}

export type FieldCatalog = ReturnType<typeof createFieldCatalog>

function printHeads(registry: Registry): ResourceMeta[] {
  const candidates = new Map<string, ResourceMeta[]>()
  const marked = new Map<string, ResourceMeta[]>()
  for (const resource of registry.list()) {
    if (resource.authz?.readAnyOf && resource.authz.readAnyOf.length > 0) continue
    const group = candidates.get(resource.permissionPrefix) ?? []
    group.push(resource)
    candidates.set(resource.permissionPrefix, group)
    if (resource.printHead) {
      const m = marked.get(resource.permissionPrefix) ?? []
      m.push(resource)
      marked.set(resource.permissionPrefix, m)
    }
  }
  const heads: ResourceMeta[] = []
  for (const [prefix, group] of candidates) {
    const explicit = marked.get(prefix) ?? []
    if (explicit.length > 1) {
      throw new Error(`权限前缀 ${prefix} 存在多个打印头资源`)
    }
    if (explicit.length === 1) {
      heads.push(explicit[0]!)
      continue
    }
    if (group.length === 1) {
      heads.push(group[0]!)
      continue
    }
    const names = group.map((r) => r.name).join(', ')
    throw new Error(
      `权限前缀 ${prefix} 的打印头资源不明确（${names}），请用 PrintHead 标记`,
    )
  }
  return heads
}

function deriveFields(registry: Registry, resource: ResourceMeta): PrintField[] {
  const names = new Set<string>()
  for (const field of resource.fields) {
    if (TECHNICAL_FIELDS.has(field.name) || field.sensitive) continue
    if (field.ref) {
      deriveRefFields(registry, resource, field, names)
      continue
    }
    if (field.type === 'fk' || field.name.endsWith('_id')) continue
    names.add(field.name)
  }
  return sortedFields(names)
}

function deriveRefFields(
  registry: Registry,
  resource: ResourceMeta,
  field: FieldMeta,
  names: Set<string>,
): void {
  const ref = field.ref
  if (!ref) return
  if (ref.variants && ref.variants.length > 0) {
    if (ref.discriminatorType !== 'enum') return
    if (field.printRawId) {
      names.add(field.name)
      return
    }
    for (const variant of ref.variants) {
      names.add(`${refPrefix(field)}.${variant.labelField}`)
    }
    return
  }
  if (!ref.resource) return
  const target = registry.get(ref.resource)
  if (!target) {
    throw new Error(
      `Meta 资源 ${resource.name} 字段 ${field.name} 的打印关联指向未知资源: ${ref.resource}`,
    )
  }
  const prefix = refPrefix(field)
  for (const targetField of target.fields) {
    if (
      TECHNICAL_FIELDS.has(targetField.name) ||
      targetField.sensitive ||
      targetField.calculated
    ) {
      continue
    }
    if (
      targetField.ref ||
      targetField.type === 'fk' ||
      targetField.name.endsWith('_id')
    ) {
      continue
    }
    names.add(`${prefix}.${targetField.name}`)
  }
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

function sortedFields(names: Set<string>): PrintField[] {
  return [...names]
    .sort()
    .map((name) => ({ name, label: name }))
}

function clonePrintResourceCatalog(value: PrintResourceCatalog): PrintResourceCatalog {
  return {
    resource: value.resource,
    fields: value.fields.map((f) => ({ ...f })),
    loops: value.loops.map((loop) => ({
      ...loop,
      fields: loop.fields.map((f) => ({ ...f })),
      nestedLoops: loop.nestedLoops ? [...loop.nestedLoops] : undefined,
    })),
  }
}

function fieldSet(fields: PrintField[]): Set<string> {
  return new Set(fields.map((f) => f.name))
}

function firstSegment(value: string): string {
  const index = value.indexOf('.')
  return index >= 0 ? value.slice(0, index) : value
}

function appendErrorPart(parts: string[], label: string, names: string[]): void {
  if (names.length === 0) return
  parts.push(`${label}: ${uniqueSorted(names).join(', ')}`)
}
