/**
 * Resource Catalog 前端端口：按能力拆分 Reader / Writer / Draft / Command。
 * contract 后 binding 是唯一资源→Adapter 关联；HTTP transport 不拥有 Meta 或命令。
 */
import type { ResourceDocument } from '@synie/shared'
import type { ResourceList, ResourceQuery } from '../types'
import type { Row } from '~/components/synie-data-grid/types'
import type { ResourceQueryCache } from './query-cache'

/** 列表与单条读取；不含 Meta 生命周期 */
export interface ResourceReader<TRow = Row> {
  query(input: ResourceQuery): Promise<ResourceList>
  get(id: string): Promise<TRow | null>
}

/** 仅 create */
export interface CreateWriter<TRow, TCreate> {
  create(input: TCreate): Promise<TRow>
}

/** 仅 update */
export interface UpdateWriter<TRow, TUpdate> {
  update(id: string, input: TUpdate): Promise<TRow>
}

/** 仅 delete */
export interface DeleteWriter {
  delete(id: string): Promise<void>
}

/**
 * 普通单记录写：create/update/delete 三方法全量形态。
 * 不支持的操作在运行时不存在（不写抛错 stub），调用方用 in/可选链收窄。
 */
export type RecordWriter = CreateWriter<Row, Record<string, unknown>> &
  UpdateWriter<Row, Record<string, unknown>> &
  DeleteWriter

/** 聚合草稿：Draft 输入与权威 SavedDraft 输出分离 */
export interface AggregateDraftAdapter<TDraft = unknown, TSaved = TDraft> {
  loadDraft(id: string): Promise<TSaved>
  createDraft(input: TDraft): Promise<TSaved>
  replaceDraft(id: string, input: TDraft): Promise<TSaved>
}

export type CommandTarget = 'collection' | 'row' | 'bulk' | 'rowOrBulk'

export interface CommandSpec<TInput = unknown, TOutput = unknown> {
  readonly target: CommandTarget
  /**
   * 命令成功后需要刷新的 ResourceBinding 资源名。
   * 失效 implementation 始终加入命令所属资源与系统审计日志，并对本列表去重。
   */
  readonly affectedResources?: readonly string[]
  execute(input: TInput): Promise<TOutput>
}

/**
 * 命令映射：key 为语义 command key。
 * 默认用 unknown 输入/输出；具体 Adapter 用 defineCommand 收窄。
 * 使用 any 以允许异构 CommandSpec 装入同一 map（异构 input 在 execute 边界解码）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandMap = Record<string, CommandSpec<any, any>>

export interface CommandAdapter<TCommands extends CommandMap = CommandMap> {
  readonly commands: TCommands
  execute<K extends keyof TCommands & string>(
    key: K,
    input: Parameters<TCommands[K]['execute']>[0],
  ): Promise<Awaited<ReturnType<TCommands[K]['execute']>>>
}

/**
 * 单一资源绑定：Grid / Drawer / 外键预览都从本入口取能力。
 * 异构 registry 一律用默认宽类型；具体资源在消费边界自行收窄。
 */
export interface ResourceBinding {
  readonly resource: string
  readonly reader: ResourceReader
  /**
   * Reader 对应的查询缓存身份与失效动作。
   * 调用者不得再拼 transport id 或 gridRows/rowById key。
   */
  readonly cache: ResourceQueryCache
  readonly writer?: RecordWriter
  readonly draft?: AggregateDraftAdapter
  readonly commands?: CommandAdapter
  /** 拉取并缓存完整 ResourceDocument v2 */
  loadDocument(): Promise<ResourceDocument>
}
