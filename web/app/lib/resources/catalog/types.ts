/**
 * Resource Catalog 前端端口：按能力拆分 Reader / Writer / Draft / Command。
 * expand 期与 legacy ResourceClient 并存；binding 是唯一资源→Adapter 关联。
 */
import type { ResourceDocument } from '@synie/shared'
import type { ResourceList, ResourceQuery } from '../types'
import type { Row } from '~/components/synie-data-grid/types'

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
 * 普通单记录写：按资源实际能力组合。
 * 不支持的操作类型上不存在（不写抛错 stub）。
 */
export type RecordWriter<
  TRow = Row,
  TCreate = Record<string, unknown>,
  TUpdate = Record<string, unknown>,
  TFlags extends {
    create?: boolean
    update?: boolean
    delete?: boolean
  } = { create: true; update: true; delete: true },
> = (TFlags['create'] extends false ? unknown : CreateWriter<TRow, TCreate>) &
  (TFlags['update'] extends false ? unknown : UpdateWriter<TRow, TUpdate>) &
  (TFlags['delete'] extends false ? unknown : DeleteWriter)

/** 聚合草稿：Draft 输入与权威 SavedDraft 输出分离 */
export interface AggregateDraftAdapter<TDraft = unknown, TSaved = TDraft> {
  loadDraft(id: string): Promise<TSaved>
  createDraft(input: TDraft): Promise<TSaved>
  replaceDraft(id: string, input: TDraft): Promise<TSaved>
}

export type CommandTarget = 'collection' | 'row' | 'bulk' | 'rowOrBulk'

export interface CommandSpec<TInput = unknown, TOutput = unknown> {
  target: CommandTarget
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
 */
export interface ResourceBinding<
  TRow = Row,
  TCreate = Record<string, unknown>,
  TUpdate = Record<string, unknown>,
  TDraft = never,
  TSaved = never,
  TCommands extends CommandMap = CommandMap,
> {
  readonly resource: string
  readonly reader: ResourceReader<TRow>
  readonly writer?: RecordWriter<TRow, TCreate, TUpdate>
  readonly draft?: AggregateDraftAdapter<TDraft, TSaved>
  readonly commands?: CommandAdapter<TCommands>
  /** 拉取并缓存完整 ResourceDocument v2 */
  loadDocument(): Promise<ResourceDocument>
}
