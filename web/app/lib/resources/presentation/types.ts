/**
 * Presentation Extension：与业务模块共置的完整资源专用 form controller。
 *
 * 不扩张 FormMeta / 全局字段插槽 DSL；动态 React、附件、OCR、子表与联动
 * 全部在本层实现。由 ResourceBinding 的 typed adapters 构造，不按 resource key
 * 再次查询全局 client registry。
 */
import type { ReactNode } from 'react'
import type { ResourceBinding } from '../catalog/types'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export type PresentationExtraContent = (
  mode: DrawerMode,
  row: Row | null | undefined,
  values: Record<string, unknown>,
  patchValues: (patch: Record<string, unknown>) => void,
) => ReactNode

/**
 * 资源专用 form controller 的静态契约面。
 * Catalog 只声明 form.kind=extension；具体呈现由本对象拥有。
 */
export interface PresentationExtension {
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
}

export type PresentationFactory = (binding: ResourceBinding) => PresentationExtension
