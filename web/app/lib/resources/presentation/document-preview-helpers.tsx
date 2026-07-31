import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import type { Row } from '~/components/synie-data-grid/types'
import type { EditableColumnOverride } from '~/components/synie-editable-table/SynieEditableTable'
import type { FieldOverride } from '~/components/synie-record-drawer/fields'
import type { DocumentPreviewConfig, PresentationExtension } from './types'

export const UNIT_NAME_OVERRIDE = {
  label: '单位',
} satisfies EditableColumnOverride

export const BASE_QTY_OVERRIDE = {
  label: '折算数量',
} satisfies EditableColumnOverride

export const LINE_REMARK_OVERRIDE = {
  label: '行备注',
} satisfies EditableColumnOverride

export const ORDER_NO_OVERRIDE = {
  label: '订单',
  render: (_value: unknown, row: Row) =>
    row.orderNo != null && row.orderNo !== '' ? String(row.orderNo) : undefined,
} satisfies EditableColumnOverride

export const UNIT_ID_SNAPSHOT_OVERRIDE = {
  render: (_value: unknown, row: Row) =>
    row.unitName != null && row.unitName !== ''
      ? String(row.unitName)
      : undefined,
} satisfies EditableColumnOverride

export function materialCodeOverride({
  label = '物料',
  drawingOwnerType,
  wide = false,
}: {
  label?: string
  drawingOwnerType?: string
  wide?: boolean
} = {}): EditableColumnOverride {
  return {
    label,
    ...(wide ? { className: 'min-w-[12rem] max-w-[18rem]' } : {}),
    render: materialCellRender(
      drawingOwnerType ? { drawingOwnerType } : undefined,
    ),
  }
}

/** 业务抽屉里 hidden 的科目槽，速览改为可见只读字段。 */
export function unhideAccountFields(
  fields: Record<string, FieldOverride>,
): Record<string, FieldOverride> {
  const next = { ...fields }
  for (const key of ['debitAccountId', 'creditAccountId'] as const) {
    if (next[key]) {
      next[key] = {
        ...next[key],
        hidden: false,
        order: next[key].order ?? 100,
      }
    }
  }
  return next
}

export function previewHead(
  presentation: PresentationExtension,
  options?: { unhideAccounts?: boolean },
): DocumentPreviewConfig['head'] {
  return {
    exclude: presentation.exclude,
    fields: options?.unhideAccounts
      ? unhideAccountFields(presentation.fields)
      : presentation.fields,
    contentClassName: presentation.contentClassName,
  }
}
