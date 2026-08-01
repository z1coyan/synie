/**
 * ResourceBinding 注册表：known key 恢复类型；unknown 显式失败。
 * contract 后 binding 是唯一资源→Adapter 关联；无独立 ResourceClient registry 入口。
 */
import type { ResourceDocument } from '@synie/shared'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceTransport } from '../types'
import { fetchResourceDocument } from './client'
import type {
  ResourceBinding,
  ResourceReader,
  RecordWriter,
} from './types'
import { createResourceQueryCache } from './query-cache'

const bindings = new Map<string, ResourceBinding>()

/**
 * 从传输实现生成 ResourceBinding。
 * 写能力按 options 与 transport 实际方法取交集；命令必须显式挂到 binding。
 */
export function bindingFromResourceTransport(
  resource: string,
  transport: ResourceTransport,
  options?: {
    canCreate?: boolean
    canUpdate?: boolean
    canDelete?: boolean
  },
): ResourceBinding {
  const canCreate = options?.canCreate ?? true
  const canUpdate = options?.canUpdate ?? true
  const canDelete = options?.canDelete ?? true

  const reader: ResourceReader = {
    query: (input) => transport.query(input),
    get: (id) => transport.get(id),
  }

  const hasWriter =
    (canCreate && transport.create != null) ||
    (canUpdate && transport.update != null) ||
    (canDelete && transport.delete != null)
  const writer: RecordWriter | undefined = hasWriter
    ? ({
        ...(canCreate && transport.create
          ? {
              create: (input: Record<string, unknown>) => transport.create!(input),
            }
          : {}),
        ...(canUpdate && transport.update
          ? {
              update: (id: string, input: Record<string, unknown>) =>
                transport.update!(id, input),
            }
          : {}),
        ...(canDelete && transport.delete
          ? {
              delete: (id: string) => transport.delete!(id),
            }
          : {}),
      } as RecordWriter)
    : undefined

  return {
    resource,
    reader,
    cache: createResourceQueryCache(resource, transport.id),
    writer,
    loadDocument: () => fetchResourceDocument(resource),
  }
}

export function registerBinding(binding: ResourceBinding): void {
  if (bindings.has(binding.resource)) {
    throw new Error(`重复 ResourceBinding: ${binding.resource}`)
  }
  bindings.set(binding.resource, binding)
}

/** 覆盖已注册 binding（挂语义 CommandAdapter / draft） */
export function replaceBinding(binding: ResourceBinding): void {
  bindings.set(binding.resource, binding)
}

export function registerBindings(items: ResourceBinding[]): void {
  for (const item of items) registerBinding(item)
}

/**
 * 按资源键取 binding；未知键显式失败（禁止空 drawer / label fallback）。
 */
export function resourceBindingFor(resource: string): ResourceBinding {
  const binding = bindings.get(resource)
  if (!binding) {
    throw new Error(`资源「${resource}」未注册 ResourceBinding`)
  }
  return binding
}

export function hasBinding(resource: string): boolean {
  return bindings.has(resource)
}

export function listBoundResources(): string[] {
  return [...bindings.keys()].sort()
}

/** 测试用 */
export function clearBindingsForTests(): void {
  bindings.clear()
}

/**
 * 将 binding 适配为传输对象（仅 query/get + 可选写）。
 * 不含 meta/action；Grid/命令应直接使用 binding。
 */
export function resourceTransportFromBinding(binding: ResourceBinding): ResourceTransport {
  const writer = binding.writer as
    | (Partial<{
        create: (input: Record<string, unknown>) => Promise<Row>
        update: (id: string, input: Record<string, unknown>) => Promise<Row>
        delete: (id: string) => Promise<void>
      }>)
    | undefined

  return {
    // 兼容 transport 必须复用 binding 的真实 Adapter identity，否则 custom/memory
    // Reader 产生的查询 key 会与 binding.cache 的失效 scope 永久错位。
    id: binding.cache.adapterId,
    query: (input) => binding.reader.query(input),
    get: (id) => binding.reader.get(id),
    ...(writer && 'create' in writer && writer.create
      ? {
          create: (input: Record<string, unknown>) => writer.create!(input),
        }
      : {}),
    ...(writer && 'update' in writer && writer.update
      ? {
          update: (id: string, input: Record<string, unknown>) =>
            writer.update!(id, input),
        }
      : {}),
    ...(writer && 'delete' in writer && writer.delete
      ? {
          delete: (id: string) => writer.delete!(id),
        }
      : {}),
  }
}

export type { ResourceDocument }
