/**
 * ResourceBinding 注册表：known key 恢复类型；unknown 显式失败。
 * contract 后 binding 是唯一资源→Adapter 关联；无独立 ResourceClient registry 入口。
 */
import type { ResourceDocument } from '@synie/shared'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceClient } from '../types'
import { fetchResourceDocument } from './client'
import type {
  CommandAdapter,
  CommandMap,
  ResourceBinding,
  ResourceReader,
  RecordWriter,
} from './types'

const bindings = new Map<string, ResourceBinding>()

/** 传输对象上可选的历史 action 桥（仅用于构造 CommandAdapter，不进 ResourceTransport 类型） */
type TransportWithLegacyAction = ResourceClient & {
  action?: (key: string, ids: string[]) => Promise<void>
}

/**
 * 从传输实现生成 ResourceBinding。
 * 写能力按 options 省略；action 若存在则桥接为 CommandAdapter。
 */
export function bindingFromResourceClient(
  resource: string,
  client: TransportWithLegacyAction,
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
    query: (input) => client.query(input),
    get: (id) => client.get(id),
  }

  const hasWriter = canCreate || canUpdate || canDelete
  const writer: RecordWriter | undefined = hasWriter
    ? ({
        ...(canCreate && client.create
          ? {
              create: (input: Record<string, unknown>) => client.create!(input),
            }
          : {}),
        ...(canUpdate && client.update
          ? {
              update: (id: string, input: Record<string, unknown>) =>
                client.update!(id, input),
            }
          : {}),
        ...(canDelete && client.delete
          ? {
              delete: (id: string) => client.delete!(id),
            }
          : {}),
      } as RecordWriter)
    : undefined

  let commands: CommandAdapter | undefined
  if (client.action) {
    const action = client.action.bind(client)
    const map: CommandMap = new Proxy({} as CommandMap, {
      get(_target, key: string) {
        return {
          target: 'rowOrBulk' as const,
          execute: async (input: { ids: string[] }) => {
            await action(key, input.ids)
          },
        }
      },
    })
    commands = {
      commands: map,
      async execute(key, input) {
        const spec = map[key]
        if (!spec) throw new Error(`资源「${resource}」无命令「${key}」`)
        return spec.execute(input as never)
      },
    }
  }

  return {
    resource,
    reader,
    writer,
    commands,
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
export function resourceClientFromBinding(binding: ResourceBinding): ResourceClient {
  const writer = binding.writer as
    | (Partial<{
        create: (input: Record<string, unknown>) => Promise<Row>
        update: (id: string, input: Record<string, unknown>) => Promise<Row>
        delete: (id: string) => Promise<void>
      }>)
    | undefined

  const unsupported = (op: string) => async () => {
    throw new Error(`资源「${binding.resource}」不支持 ${op}`)
  }
  return {
    id: `rest:${binding.resource}`,
    query: (input) => binding.reader.query(input),
    get: (id) => binding.reader.get(id),
    create:
      writer && 'create' in writer && writer.create
        ? (input: Record<string, unknown>) => writer.create!(input)
        : (unsupported('create') as (input: Record<string, unknown>) => Promise<Row>),
    update:
      writer && 'update' in writer && writer.update
        ? (id: string, input: Record<string, unknown>) => writer.update!(id, input)
        : ((unsupported('update') as unknown) as (
            id: string,
            input: Record<string, unknown>,
          ) => Promise<Row>),
    delete:
      writer && 'delete' in writer && writer.delete
        ? (id: string) => writer.delete!(id)
        : (unsupported('delete') as (id: string) => Promise<void>),
  }
}

export type { ResourceDocument }
