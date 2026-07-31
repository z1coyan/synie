import type { ResourceTransport } from '~/lib/resources/types'
import type { Row } from '../synie-data-grid/types'
import type { EditableColumnOverride } from '../synie-editable-table/SynieEditableTable'
import type { ResourceDrawerConfig } from './extension-drawer-props'

/** 只读速览中的一张子表（库存相关行等） */
export interface DocumentPreviewLineTable {
  /** section 标题，如「出入库行」「材料扣减行」 */
  title: string
  /** 子资源 GridMeta 名，如 invStockDocItems */
  resource: string
  /**
   * 默认按 parentIdField 过滤 client.query；
   * 若子表不直接挂父单（如委外入库扣减行挂入库条目），提供 load。
   */
  client: ResourceTransport
  /** 过滤父单的字段名，如 stockDocId；有 load 时可省略语义、仅作文档 */
  parentIdField: string
  /** 自定义拉行（优先于 parentIdField 默认 query） */
  load?: (parentId: string) => Promise<Row[]>
  /** 表格列顺序；缺省 meta 全列（仍受 exclude） */
  columns?: string[]
  /** 从表单/表格剔除（父外键、冗余头投影等） */
  exclude?: string[]
  overrides?: Record<string, EditableColumnOverride>
  /** 排序列，默认 idx */
  sortColumn?: string
  /** 拉取上限，默认 200（与业务抽屉对齐） */
  limit?: number
}

/**
 * 单据只读速览配置：标题（单号+状态）+ 只读头 + 子表。
 * 与编辑抽屉解耦；未登记资源走 FkPreview 基础表单退化路径。
 */
export interface DocumentPreviewConfig {
  label: string
  /** 单号字段，进标题区 */
  docNoField: string
  /** 状态字段，进标题区；缺省 status */
  statusField?: string
  /** 头区：对齐业务抽屉只读子集 */
  head: Pick<ResourceDrawerConfig, 'exclude' | 'fields' | 'contentClassName'>
  lineTables: DocumentPreviewLineTable[]
}

const registry = new Map<string, DocumentPreviewConfig>()

/** 登记资源只读速览；同 key 后写覆盖（便于测试/热更） */
export function registerDocumentPreview(resource: string, config: DocumentPreviewConfig): void {
  registry.set(resource, config)
}

export function getDocumentPreview(resource: string): DocumentPreviewConfig | null {
  return registry.get(resource) ?? null
}

/** 已登记资源键（测试/调试） */
export function listDocumentPreviewKeys(): string[] {
  return [...registry.keys()].sort()
}
