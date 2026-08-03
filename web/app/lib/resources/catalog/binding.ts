/**
 * ResourceBinding 构造与适配：known key 恢复类型；unknown 显式失败（在 registry.ts）。
 * contract 后 binding 是唯一资源→Adapter 关联；唯一注册表为 ../registry.ts 的
 * productionBindings，本文件不再持有任何可变注册状态。
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
