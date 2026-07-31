/**
 * Presentation Extension：与业务模块共置的完整资源专用 form controller。
 *
 * 不扩张 FormMeta / 全局字段插槽 DSL；动态 React、附件、OCR、子表与联动
 * 全部在本层实现。由 ResourceBinding 的 typed adapters 构造，不按 resource key
 * 再次查询全局 client registry。
 */
import type { ReactNode } from 'react'
import type { ResourceBinding, ResourceReader } from '../catalog/types'
import type { SynieRecordDrawerProps } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type {
  DrawerMode,
  FieldOverride,
} from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import type { EditableColumnOverride } from '~/components/synie-editable-table/SynieEditableTable'

export type PresentationExtraContent = (
  mode: DrawerMode,
  row: Row | null | undefined,
  values: Record<string, unknown>,
  patchValues: (patch: Record<string, unknown>) => void,
) => ReactNode

/** Presentation Extension 提供给通用抽屉的完整静态呈现。 */
export type ResourceDrawerConfig = Pick<
  SynieRecordDrawerProps,
  'exclude' | 'fields' | 'contentClassName' | 'extraContent' | 'tabs'
> & { label: string }

/** Document Preview 自定义 loader 只解析最小 Reader，不持有生产 transport。 */
export type DocumentPreviewReaderResolver = (resource: string) => ResourceReader

/** 只读速览中的一张子表（库存相关行等）。 */
export interface DocumentPreviewLineTable {
  /** section 标题，如「出入库行」「材料扣减行」 */
  title: string
  /** 子资源 GridMeta 名，如 invStockDocItems */
  resource: string
  /**
   * 默认按 parentIdField 过滤该资源 binding.reader；
   * 若子表不直接挂父单（如委外入库扣减行挂入库条目），提供 load。
   */
  /** 过滤父单的字段名，如 stockDocId；有 load 时可省略语义、仅作文档 */
  parentIdField: string
  /** 自定义拉行（优先于 parentIdField 默认 query） */
  load?: (
    parentId: string,
    resolveReader: DocumentPreviewReaderResolver,
  ) => Promise<Row[]>
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

/**
 * 资源专用 form controller 的静态契约面。
 * Catalog 只声明 form.kind=extension；具体呈现由本对象拥有。
 */
export interface PresentationExtension extends ResourceDrawerConfig {
  readonly resource: string
  readonly kind: 'extension'
  /** 展示标签（可覆盖 Catalog label） */
  readonly label: string
  /** 从表单排除的系统/只读字段 */
  readonly exclude: string[]
  /** 静态字段策略（required/placeholder/order 等）；动态 input 由页面或 extra 补充 */
  readonly fields: Record<string, FieldOverride>
  /** 附件/OCR/子表等与业务共置的呈现 */
  readonly extraContent?: PresentationExtraContent
  /** 构造本 Extension 时注入的 binding（typed adapters 唯一入口） */
  readonly binding: ResourceBinding
  /** 该资源的只读文档速览；没有专用速览时缺席。 */
  readonly documentPreview?: DocumentPreviewConfig
}

export type PresentationFactory = (
  binding: ResourceBinding,
) => PresentationExtension
