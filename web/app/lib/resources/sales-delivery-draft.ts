/**
 * 销售发货草稿的 build 链与服务端错误路径映射：表单态 → wire input 的唯一实现。
 * 与 wire 校验（fulfillment.ts 的 salesDeliveryDraftInput）共置同侧，抽屉只留渲染。
 */
import type { Row } from '~/components/synie-data-grid/types'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { nullableString, requiredIndex, requiredString } from './draft-fields'
import type {
  SalesDeliveryDraftInput,
  SalesDeliveryDraftItemInput,
  SalesDeliveryDraftPackLineInput,
} from './fulfillment'

/** 提交 mutation:物料/单位由订单条目锁定带出,后端再快照与折算 */
function itemInput(row: Row): SalesDeliveryDraftItemInput {
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '发货条目序号'),
    orderItemId: requiredString(row.orderItemId, '订单条目'),
    unitId: nullableString(row.unitId),
    qty: requiredString(row.qty, '发货数量'),
    // 行仓可空:虚拟/资产行不入仓;库存类行缺仓由后端保存校验兜底(「库存类物料必须填写行仓」)
    warehouseId: nullableString(row.warehouseId),
    remarks: nullableString(row.remarks),
  }
}

/** 提交 mutation:快照字段由后端保存时重拍；所属箱由嵌套层级表达。 */
function packLineInput(row: Row): SalesDeliveryDraftPackLineInput {
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '装箱条目序号'),
    materialId: requiredString(row.materialId, '装箱物料'),
    unitId: nullableString(row.unitId),
    qty: requiredString(row.qty, '装箱数量'),
    remarks: nullableString(row.remarks),
  }
}

export interface DeliveryDraftIndex {
  itemRowIds: string[]
  boxRowIds: string[]
  lineRowIds: string[][]
}

export function buildDeliveryDraft(
  values: Record<string, unknown>,
  items: Row[],
  packBoxes: Row[],
  packLines: Row[],
): { draft: SalesDeliveryDraftInput; index: DeliveryDraftIndex } {
  const linesByBox = packBoxes.map((box) =>
    packLines.filter((line) => String(line.packBoxId) === String(box.id)),
  )
  return {
    draft: {
      companyId: requiredString(values.companyId, '公司'),
      deliveryNo: nullableString(values.deliveryNo),
      deliveryDate: nullableString(values.deliveryDate),
      postingDate: nullableString(values.postingDate),
      partyType: requiredString(values.partyType, '对手类型'),
      partyId: requiredString(values.partyId, '对手'),
      remarks: nullableString(values.remarks),
      warehouseId: nullableString(values.warehouseId),
      debitAccountId: requiredString(values.debitAccountId, '借方科目'),
      creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
      items: items.map(itemInput),
      packBoxes: packBoxes.map((box, boxIndex) => ({
        ...(!isLocalRow(box) ? { id: String(box.id) } : {}),
        lines: linesByBox[boxIndex].map(packLineInput),
      })),
    },
    index: {
      itemRowIds: items.map((row) => String(row.id)),
      boxRowIds: packBoxes.map((row) => String(row.id)),
      lineRowIds: linesByBox.map((lines) => lines.map((row) => String(row.id))),
    },
  }
}

export function normalizedErrorPath(path: string): string {
  return path.replace(/\.(\d+)(?=\.|$)/g, '[$1]')
}

export function headerFieldErrors(fields: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [rawPath, messages] of Object.entries(fields)) {
    const path = normalizedErrorPath(rawPath)
    if (path.startsWith('items') || path.startsWith('packBoxes')) continue
    const field = path.startsWith('header.') ? path.slice('header.'.length) : path
    result[field] = [...(result[field] ?? []), ...messages]
  }
  return result
}

export function rowErrors(
  fields: Record<string, string[]>,
  pattern: RegExp,
  resolve: (...indexes: number[]) => Row | undefined,
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [rawPath, messages] of Object.entries(fields)) {
    const matched = pattern.exec(normalizedErrorPath(rawPath))
    if (!matched) continue
    const indexes = matched.slice(1, -1).map(Number)
    const row = resolve(...indexes)
    if (!row) continue
    const field = matched.at(-1)
    const rendered = messages.map((message) => (field ? `${field}: ${message}` : message))
    result[String(row.id)] = [...(result[String(row.id)] ?? []), ...rendered]
  }
  return result
}
