/**
 * CommandAdapter 辅助：按 target 解码输入，非法 target fail-closed。
 * transport path / payload / response 映射只属于各资源 Adapter，不在此文件。
 */
import type { CommandAdapter, CommandMap, CommandSpec, CommandTarget } from './types'

export type RowCommandInput = { id: string }
/** bulk：非空 ID 集合 */
export type BulkCommandInput = { ids: string[] }
/** rowOrBulk：至少一个 ID（恰好一个时等价 row） */
export type RowOrBulkCommandInput = { ids: string[] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 须为非空字符串`)
  }
  return value
}

/**
 * row：恰好一个记录 ID。
 * 接受 `{ id }`；拒绝空 id、ids 数组或其它伪装。
 */
export function decodeRowTarget(input: unknown): string {
  if (!isObject(input)) {
    throw new Error('row command 输入须为对象且包含恰好一个 id')
  }
  if ('ids' in input) {
    throw new Error('row command 不接受 ids；请传恰好一个 id')
  }
  return asNonEmptyString(input.id, 'row command id')
}

/**
 * bulk：非空 ID 集合。空数组与非数组均失败。
 */
export function decodeBulkTarget(input: unknown): string[] {
  if (!isObject(input)) {
    throw new Error('bulk command 输入须为对象且包含非空 ids')
  }
  if (!Array.isArray(input.ids)) {
    throw new Error('bulk command 需要非空 ids 数组')
  }
  if (input.ids.length === 0) {
    throw new Error('bulk command 的 ids 不可为空')
  }
  return input.ids.map((id, i) => asNonEmptyString(id, `bulk command ids[${i}]`))
}

/**
 * rowOrBulk：至少一个 ID。
 */
export function decodeRowOrBulkTarget(input: unknown): string[] {
  if (!isObject(input)) {
    throw new Error('rowOrBulk command 输入须为对象且包含非空 ids')
  }
  // 兼容单条 { id }
  if ('id' in input && !('ids' in input)) {
    return [asNonEmptyString(input.id, 'rowOrBulk command id')]
  }
  return decodeBulkTarget(input)
}

/**
 * collection：不需要记录 ID。若误传 ids/id 作为唯一载荷意图，在边界拒绝伪造 target。
 * 领域 payload（如 dateFrom/dateTo）原样返回。
 */
export function decodeCollectionTarget<T extends Record<string, unknown>>(
  input: unknown,
): T {
  if (input === undefined || input === null) {
    return {} as T
  }
  if (!isObject(input)) {
    throw new Error('collection command 输入须为对象')
  }
  // 仅有 id/ids 而无其它字段时，视为伪造记录 target
  const keys = Object.keys(input)
  if (keys.length > 0 && keys.every((k) => k === 'id' || k === 'ids')) {
    throw new Error('collection command 不需要记录 ID，请勿传 id/ids 作为 target')
  }
  return input as T
}

export function createCommandAdapter<TCommands extends CommandMap>(
  commands: TCommands,
): CommandAdapter<TCommands> {
  const adapter: CommandAdapter<TCommands> = {
    commands,
    execute(key, input) {
      const spec = commands[key]
      if (!spec) {
        return Promise.reject(new Error(`未知命令「${String(key)}」`))
      }
      return spec.execute(input) as Promise<
        Awaited<ReturnType<TCommands[typeof key]['execute']>>
      >
    },
  }
  return adapter
}

export function defineCommand<TInput, TOutput = void>(
  target: CommandTarget,
  execute: (input: TInput) => Promise<TOutput>,
): CommandSpec<TInput, TOutput> {
  return { target, execute }
}

type RowCommandHandler = (id: string) => Promise<unknown>
type RowCommandHandlers = Record<string, RowCommandHandler>

type RowCommandSpecs<THandlers extends RowCommandHandlers> = {
  [K in keyof THandlers]: CommandSpec<
    unknown,
    Awaited<ReturnType<THandlers[K]>>
  >
}

/**
 * 一组显式 row 命令的语义 Adapter。key 与 transport handler 在资源模块内逐项声明；
 * 这里只复用 target 解码，不做开放 key Proxy。
 */
export function createRowCommandAdapter<const THandlers extends RowCommandHandlers>(
  handlers: THandlers,
): CommandAdapter<RowCommandSpecs<THandlers>> {
  const commands = Object.fromEntries(
    Object.entries(handlers).map(([key, handler]) => [
      key,
      defineCommand('row', async (input: unknown) => {
        const id = decodeRowTarget(input)
        return handler(id)
      }),
    ]),
  ) as RowCommandSpecs<THandlers>
  return createCommandAdapter(commands)
}
