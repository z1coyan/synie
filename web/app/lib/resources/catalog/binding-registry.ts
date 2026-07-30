/**
 * ResourceBinding 注册表：known key 恢复类型；unknown 显式失败。
 * expand 期可用 fromResourceClient 从现有 ResourceClient 生成兼容 binding。
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

/** 从 legacy ResourceClient 生成 expand 期兼容 binding（不复制第二份业务逻辑） */
export function bindingFromResourceClient(
  resource: string,
  client: ResourceClient,
  options?: {
    /** 省略不支持的写方法 */
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

  const writer: RecordWriter = {
    ...(canCreate
      ? {
          create: (input: Record<string, unknown>) => client.create(input),
        }
      : {}),
    ...(canUpdate
      ? {
          update: (id: string, input: Record<string, unknown>) => client.update(id, input),
        }
      : {}),
    ...(canDelete
      ? {
          delete: (id: string) => client.delete(id),
        }
      : {}),
  } as RecordWriter

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

/** 将 binding 的 Reader/Writer 适配为 legacy ResourceClient（Grid expand 兼容） */
export function resourceClientFromBinding(binding: ResourceBinding): ResourceClient {
  const writer = binding.writer as
    | (Partial<{
        create: (input: Record<string, unknown>) => Promise<Row>
        update: (id: string, input: Record<string, unknown>) => Promise<Row>
        delete: (id: string) => Promise<void>
      }>)
    | undefined

  return {
    id: `binding:${binding.resource}`,
    async meta() {
      // expand：仍走旧 gridMeta 路径所需的 Grid 子集，由调用方 useGridMeta 使用 client.meta
      // binding 场景下 meta 从 document.grid 派生见 gridMetaFromDocument
      const { gridMetaFromDocument } = await import('./grid-from-document')
      const doc = await binding.loadDocument()
      return gridMetaFromDocument(doc)
    },
    query: (input) => binding.reader.query(input),
    get: (id) => binding.reader.get(id),
    create: (input) => {
      if (!writer || !('create' in writer) || !writer.create) {
        throw new Error(`资源「${binding.resource}」不支持 create`)
      }
      return writer.create(input)
    },
    update: (id, input) => {
      if (!writer || !('update' in writer) || !writer.update) {
        throw new Error(`资源「${binding.resource}」不支持 update`)
      }
      return writer.update(id, input)
    },
    delete: (id) => {
      if (!writer || !('delete' in writer) || !writer.delete) {
        throw new Error(`资源「${binding.resource}」不支持 delete`)
      }
      return writer.delete(id)
    },
    action: binding.commands
      ? async (key, ids) => {
          await binding.commands!.execute(key, { ids } as never)
        }
      : undefined,
  }
}

export type { ResourceDocument }
