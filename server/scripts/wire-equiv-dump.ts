/**
 * wire 等价对拍（D8 字节冻结验收）：dump 各 trading 模块 presenter 输出形状
 * （键序/键集/值）与草稿 zod 行为语料（通过/拒绝 + issue 路径文案），
 * 迁移前后各跑一次 diff——零差异才算派生与手写等价。
 *
 * 用法：bun scripts/wire-equiv-dump.ts <输出.json>
 * 语料行取生产行形（标准服务 mapRow + 投影 mapExtra 输出：date 为 YYYY-MM-DD
 * 字符串、datetime 为 Date、decimal 为 toFixed 字符串）；mapExtras/mapItemDto
 * 语料为 db 原生行（snake_case）。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

import {
  mapReturnItemExtras,
  presentReturnDraft,
  presentReturnHead,
  presentReturnItem,
} from '../src/modules/trading/returns/views.ts'
import {
  draftCreateSchema as returnDraftCreate,
  draftItemSchema as returnDraftItem,
  draftReplaceSchema as returnDraftReplace,
} from '../src/modules/trading/returns/routes.ts'
import {
  mapItemDto,
  mapPurchaseItemExtras,
  mapSalesItemExtras,
  presentPackBox,
  presentPackLine,
  presentPurchaseDraft,
  presentPurchaseHead,
  presentPurchaseItem,
  presentSalesDraft,
  presentSalesHead,
  presentSalesItem,
} from '../src/modules/trading/fulfillment/views.ts'
import {
  purchaseReceiptDraftCreateSchema as purDraftCreate,
  purchaseReceiptDraftReplaceSchema as purDraftReplace,
  salesDraftCreateSchema as salDraftCreate,
  salesDraftReplaceSchema as salDraftReplace,
} from '../src/modules/trading/fulfillment/routes.ts'
import {
  headExtras as reconHeadExtras,
  itemExtras as reconItemExtras,
  presentHead as reconPresentHead,
  presentItem as reconPresentItem,
} from '../src/modules/trading/reconciliation/views.ts'
import {
  reconciliationDraftCreateSchema as reconDraftCreate,
  reconciliationDraftItemSchema as reconDraftItem,
  reconciliationDraftReplaceSchema as reconDraftReplace,
} from '../src/modules/trading/reconciliation/routes.ts'

const UUID = '11111111-2222-3333-4444-555555555555'
const UUID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DT = new Date('2026-08-01T10:20:30.000Z')

type Kind = 'str' | 'dec' | 'date' | 'dt' | 'enum' | 'int' | 'fk'
type FieldSpec = readonly [string, Kind, boolean] // key, 取值样例型, 可空

const SAMPLE: Record<Kind, unknown> = {
  str: '样例',
  dec: '12.345600',
  date: '2026-08-01',
  dt: DT,
  enum: 'customer',
  int: 7,
  fk: UUID,
}

/** 由字段清单生成两条语料行：全值行 / 可空键全 null 行 */
function corpusRows(fields: readonly FieldSpec[]): Record<string, unknown>[] {
  const full: Record<string, unknown> = {}
  const nulls: Record<string, unknown> = {}
  for (const [key, kind, nullable] of fields) {
    full[key] = SAMPLE[kind]
    nulls[key] = nullable ? null : SAMPLE[kind]
  }
  return [full, nulls]
}

const RETURN_HEAD: FieldSpec[] = [
  ['id', 'fk', false], ['returnNo', 'str', false], ['returnDate', 'date', false],
  ['postingDate', 'date', true], ['partyType', 'enum', false], ['partyId', 'fk', false],
  ['currencyId', 'fk', true], ['exchangeRate', 'dec', true], ['remarks', 'str', true],
  ['status', 'enum', false], ['auditedAt', 'dt', true], ['insertedAt', 'dt', false],
  ['updatedAt', 'dt', false], ['companyId', 'fk', false], ['warehouseId', 'fk', true],
  ['debitAccountId', 'fk', true], ['creditAccountId', 'fk', true],
  ['createdById', 'fk', true], ['auditedById', 'fk', true],
]

const RETURN_ITEM: FieldSpec[] = [
  ['id', 'fk', false], ['idx', 'int', false], ['qty', 'dec', false], ['baseQty', 'dec', false],
  ['materialCode', 'str', true], ['materialName', 'str', true], ['materialSpec', 'str', true],
  ['customerPartNo', 'str', true], ['unitName', 'str', true], ['orderNo', 'str', true],
  ['orderQty', 'dec', true], ['orderBaseQty', 'dec', true], ['orderUnitName', 'str', true],
  ['orderPrice', 'dec', true], ['orderAmount', 'dec', true], ['orderBasePrice', 'dec', true],
  ['orderBaseAmount', 'dec', true], ['orderTaxRate', 'dec', true],
  ['orderCurrencyCode', 'str', true], ['reconciledQty', 'dec', false], ['remarks', 'str', true],
  ['insertedAt', 'dt', false], ['updatedAt', 'dt', false], ['returnId', 'fk', false],
  ['companyId', 'fk', false], ['deliveryItemId', 'fk', true], ['receiptItemId', 'fk', true],
  ['outsourcedReceiptItemId', 'fk', true], ['orderItemId', 'fk', true],
  ['materialId', 'fk', true], ['unitId', 'fk', true], ['warehouseId', 'fk', true],
  ['returnNo', 'str', false], ['returnDate', 'date', false], ['returnStatus', 'enum', false],
  ['partyType', 'enum', false], ['partyId', 'fk', false], ['remainingReconcilableQty', 'dec', true],
]

const FULFILL_HEAD = (no: string, date: string): FieldSpec[] => [
  ['id', 'fk', false], [no, 'str', false], [date, 'date', false],
  ['postingDate', 'date', true], ['partyType', 'enum', false], ['partyId', 'fk', false],
  ['remarks', 'str', true], ['status', 'enum', false], ['auditedAt', 'dt', true],
  ['insertedAt', 'dt', false], ['updatedAt', 'dt', false], ['companyId', 'fk', false],
  ['warehouseId', 'fk', true], ['debitAccountId', 'fk', false], ['creditAccountId', 'fk', false],
  ['createdById', 'fk', true], ['auditedById', 'fk', true],
]

const FULFILL_ITEM = (idKey: string, no: string, date: string, statusKey: string): FieldSpec[] => [
  ['id', 'fk', false], ['idx', 'int', false], ['qty', 'dec', false], ['baseQty', 'dec', false],
  ['materialCode', 'str', false], ['materialName', 'str', false], ['materialSpec', 'str', true],
  ['customerPartNo', 'str', true], ['unitName', 'str', false], ['orderNo', 'str', false],
  ['orderQty', 'dec', false], ['orderBaseQty', 'dec', false], ['orderUnitName', 'str', false],
  ['orderPrice', 'dec', false], ['orderAmount', 'dec', false], ['orderBasePrice', 'dec', false],
  ['orderBaseAmount', 'dec', false], ['orderTaxRate', 'dec', false],
  ['orderCurrencyCode', 'str', false], ['reconciledQty', 'dec', false], ['remarks', 'str', true],
  ['insertedAt', 'dt', false], ['updatedAt', 'dt', false], [idKey, 'fk', false],
  ['companyId', 'fk', false], ['orderItemId', 'fk', false], ['materialId', 'fk', false],
  ['unitId', 'fk', false], ['warehouseId', 'fk', true], [no, 'str', false],
  [date, 'date', false], [statusKey, 'enum', false], ['partyType', 'enum', false],
  ['partyId', 'fk', false], ['remainingReconcilableQty', 'dec', true],
  ['returnedQty', 'dec', false], ['remainingReturnableQty', 'dec', true],
]

const PACK_BOX: FieldSpec[] = [
  ['id', 'fk', false], ['boxNo', 'int', false], ['insertedAt', 'dt', false],
  ['updatedAt', 'dt', false], ['deliveryId', 'fk', false], ['companyId', 'fk', false],
]

const PACK_LINE: FieldSpec[] = [
  ['id', 'fk', false], ['idx', 'int', false], ['packBoxId', 'fk', false], ['qty', 'dec', false],
  ['baseQty', 'dec', false], ['materialCode', 'str', false], ['materialName', 'str', false],
  ['materialSpec', 'str', true], ['customerPartNo', 'str', true], ['unitName', 'str', false],
  ['remarks', 'str', true], ['insertedAt', 'dt', false], ['updatedAt', 'dt', false],
  ['deliveryId', 'fk', false], ['companyId', 'fk', false], ['materialId', 'fk', false],
  ['unitId', 'fk', false],
]

const RECON_HEAD: FieldSpec[] = [
  ['id', 'fk', false], ['reconciliationNo', 'str', false], ['reconciliationType', 'enum', false],
  ['partyType', 'enum', false], ['partyId', 'fk', false], ['postingDate', 'date', true],
  ['remarks', 'str', true], ['status', 'enum', false], ['insertedAt', 'dt', false],
  ['updatedAt', 'dt', false], ['companyId', 'fk', false], ['debitAccountId', 'fk', false],
  ['creditAccountId', 'fk', false], ['createdById', 'fk', true],
  ['grossTotal', 'dec', false], ['baseGrossTotal', 'dec', false],
]

const RECON_ITEM = (no: string, date: string): FieldSpec[] => [
  ['id', 'fk', false], ['idx', 'int', false], ['qty', 'dec', false], ['baseQty', 'dec', false],
  ['amount', 'dec', false], ['baseAmount', 'dec', false], ['remarks', 'str', true],
  ['insertedAt', 'dt', false], ['updatedAt', 'dt', false], ['reconciliationId', 'fk', false],
  ['companyId', 'fk', false], ['deliveryItemId', 'fk', true], ['returnItemId', 'fk', true],
  ['receiptItemId', 'fk', true], ['outsourcedReceiptItemId', 'fk', true],
  ['reconciliationNo', 'str', false], ['reconciliationStatus', 'enum', false],
  [no, 'str', false], [date, 'date', true], ['materialName', 'str', false],
  ['unitName', 'str', false], ['orderCurrencyCode', 'str', false],
]

function dumpPresent(fn: (row: Record<string, unknown>) => unknown, fields: FieldSpec[]) {
  return corpusRows(fields).map((row, i) => ({
    case: i === 0 ? 'full' : 'nulls',
    out: fn(row),
  }))
}

/** db 原生行语料（snake_case）：mapExtras / mapItemDto 用 */
function rawRows(snake: Record<string, unknown>, fallbacks: string[]): Record<string, unknown>[] {
  const full = { ...snake }
  const missing = { ...snake }
  for (const key of fallbacks) delete missing[key]
  return [full, missing]
}

const dump: Record<string, unknown> = { presenters: {}, schemas: {}, extras: {} }
const P = dump.presenters as Record<string, unknown>
const S = dump.schemas as Record<string, unknown>
const E = dump.extras as Record<string, unknown>

// —— returns ——
P['returns.head'] = dumpPresent(presentReturnHead, RETURN_HEAD)
P['returns.item'] = dumpPresent(presentReturnItem, RETURN_ITEM)
{
  const [h] = corpusRows(RETURN_HEAD)
  const items = corpusRows(RETURN_ITEM)
  P['returns.draft'] = [{ case: 'full+nulls', out: presentReturnDraft({ ...h, items }) }]
}
E['returns.mapReturnItemExtras'] = rawRows(
  {
    base_qty: '10.000000', reconciled_qty: '2.000000', return_no: 'SR-1',
    return_date: DT, return_status: 'audited', party_type: 'customer',
    remaining_reconcilable_qty: '8.000000',
  },
  ['remaining_reconcilable_qty', 'return_no', 'return_date', 'return_status', 'party_type'],
).map((row, i) => ({ case: i === 0 ? 'full' : 'fallback', out: mapReturnItemExtras(row) }))

// —— fulfillment ——
P['fulfillment.salesHead'] = dumpPresent(presentSalesHead, FULFILL_HEAD('deliveryNo', 'deliveryDate'))
P['fulfillment.purchaseHead'] = dumpPresent(
  presentPurchaseHead,
  FULFILL_HEAD('receiptNo', 'receiptDate'),
)
P['fulfillment.salesItem'] = dumpPresent(
  presentSalesItem,
  FULFILL_ITEM('deliveryId', 'deliveryNo', 'deliveryDate', 'deliveryStatus'),
)
P['fulfillment.purchaseItem'] = dumpPresent(
  presentPurchaseItem,
  FULFILL_ITEM('receiptId', 'receiptNo', 'receiptDate', 'receiptStatus'),
)
P['fulfillment.packBox'] = dumpPresent(presentPackBox, PACK_BOX)
P['fulfillment.packLine'] = dumpPresent(presentPackLine, PACK_LINE)
{
  const [sh] = corpusRows(FULFILL_HEAD('deliveryNo', 'deliveryDate'))
  const [ph] = corpusRows(FULFILL_HEAD('receiptNo', 'receiptDate'))
  const sItems = corpusRows(FULFILL_ITEM('deliveryId', 'deliveryNo', 'deliveryDate', 'deliveryStatus'))
  const pItems = corpusRows(FULFILL_ITEM('receiptId', 'receiptNo', 'receiptDate', 'receiptStatus'))
  const boxes = corpusRows(PACK_BOX).map((b) => ({ ...b, lines: corpusRows(PACK_LINE) }))
  P['fulfillment.salesDraft'] = [
    { case: 'full', out: presentSalesDraft({ ...sh, items: sItems, packBoxes: boxes }) },
    { case: 'missing-children', out: presentSalesDraft({ ...sh }) },
  ]
  P['fulfillment.purchaseDraft'] = [
    { case: 'full', out: presentPurchaseDraft({ ...ph, items: pItems }) },
    { case: 'missing-children', out: presentPurchaseDraft({ ...ph }) },
  ]
}
const fulfillRawBase = {
  base_qty: '10.000000', reconciled_qty: '2.000000', returned_qty: '1.000000',
  party_type: 'customer', remaining_reconcilable_qty: '8.000000',
  remaining_returnable_qty: '9.000000',
}
E['fulfillment.mapSalesItemExtras'] = rawRows(
  {
    ...fulfillRawBase, delivery_no: 'SD-1', delivery_date: DT, delivery_status: 'audited',
  },
  ['remaining_reconcilable_qty', 'remaining_returnable_qty', 'delivery_no', 'delivery_date'],
).map((row, i) => ({ case: i === 0 ? 'full' : 'fallback', out: mapSalesItemExtras(row) }))
E['fulfillment.mapPurchaseItemExtras'] = rawRows(
  {
    ...fulfillRawBase, receipt_no: 'PR-1', receipt_date: DT, receipt_status: 'draft',
  },
  ['remaining_reconcilable_qty', 'remaining_returnable_qty', 'receipt_no', 'receipt_date'],
).map((row, i) => ({ case: i === 0 ? 'full' : 'fallback', out: mapPurchaseItemExtras(row) }))
{
  const itemDtoRow = {
    id: UUID, idx: 1, qty: '5.000000', base_qty: '5.000000', material_code: 'M1',
    material_name: '物料', material_spec: null, customer_part_no: null, unit_name: '件',
    order_no: 'SO-1', order_qty: '5.000000', order_base_qty: '5.000000',
    order_unit_name: '件', order_price: '1.2000', order_amount: '6.00',
    order_base_price: '1.2000', order_base_amount: '6.00', order_tax_rate: '0.1300',
    order_currency_code: 'CNY', reconciled_qty: '0.000000', remarks: null,
    inserted_at: DT, updated_at: DT, delivery_id: UUID, receipt_id: UUID2, head_id: UUID2,
    company_id: UUID, order_item_id: UUID, material_id: UUID, unit_id: UUID,
    warehouse_id: null, delivery_no: 'SD-1', delivery_date: DT, delivery_status: 'draft',
    receipt_no: 'PR-1', receipt_date: DT, receipt_status: 'draft',
    party_type: 'customer', party_id: UUID, remaining_reconcilable_qty: '5.000000',
    returned_qty: '0.000000', remaining_returnable_qty: '5.000000',
  }
  const fallbackRow = { ...itemDtoRow }
  delete (fallbackRow as Record<string, unknown>).remaining_reconcilable_qty
  delete (fallbackRow as Record<string, unknown>).remaining_returnable_qty
  E['fulfillment.mapItemDto.sales'] = [
    { case: 'full', out: mapItemDto('sales', itemDtoRow) },
    { case: 'fallback', out: mapItemDto('sales', fallbackRow) },
  ]
  E['fulfillment.mapItemDto.purchase'] = [
    { case: 'full', out: mapItemDto('purchase', itemDtoRow) },
    { case: 'fallback', out: mapItemDto('purchase', fallbackRow) },
  ]
}

// —— reconciliation ——
P['reconciliation.head'] = dumpPresent(reconPresentHead, RECON_HEAD)
P['reconciliation.item.sales'] = corpusRows(RECON_ITEM('deliveryNo', 'deliveryDate')).map(
  (row, i) => ({ case: i === 0 ? 'full' : 'nulls', out: reconPresentItem('sales', row) }),
)
P['reconciliation.item.purchase'] = corpusRows(RECON_ITEM('receiptNo', 'receiptDate')).map(
  (row, i) => ({ case: i === 0 ? 'full' : 'nulls', out: reconPresentItem('purchase', row) }),
)
E['reconciliation.headExtras'] = [
  { case: 'full', out: reconHeadExtras({ gross_total: '10.00', base_gross_total: '9.00' }) },
  { case: 'missing', out: reconHeadExtras({}) },
]
E['reconciliation.itemExtras.sales'] = [
  {
    case: 'full',
    out: reconItemExtras('sales', {
      reconciliation_no: 'RC-1', reconciliation_status: 'draft', delivery_no: 'SD-1',
      delivery_date: DT, material_name: '物料', unit_name: '件', order_currency_code: 'CNY',
    }),
  },
  {
    case: 'null-source',
    out: reconItemExtras('sales', {
      reconciliation_no: 'RC-1', reconciliation_status: 'draft', delivery_no: null,
      delivery_date: null, material_name: null, unit_name: null, order_currency_code: null,
    }),
  },
]
E['reconciliation.itemExtras.purchase'] = [
  {
    case: 'full',
    out: reconItemExtras('purchase', {
      reconciliation_no: 'RC-2', reconciliation_status: 'confirmed', receipt_no: 'PR-1',
      receipt_date: DT, material_name: '物料', unit_name: '件', order_currency_code: 'CNY',
    }),
  },
  {
    case: 'null-source',
    out: reconItemExtras('purchase', {
      reconciliation_no: 'RC-2', reconciliation_status: 'confirmed', receipt_no: null,
      receipt_date: null, material_name: null, unit_name: null, order_currency_code: null,
    }),
  },
]

// —— 草稿 zod 行为语料 ——
function dumpSchema(schema: z.ZodTypeAny, payloads: Record<string, unknown>) {
  return Object.entries(payloads).map(([name, payload]) => {
    const r = schema.safeParse(payload)
    if (r.success) {
      return { case: name, ok: true, keys: Object.keys(r.data as object), data: r.data }
    }
    return {
      case: name,
      ok: false,
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    }
  })
}

const returnHeadValid = {
  companyId: UUID,
  returnNo: null,
  returnDate: '2026-08-01',
  postingDate: '2026-08-01',
  partyType: 'customer',
  partyId: UUID,
  currencyId: UUID,
  exchangeRate: '1.000000',
  remarks: null,
  warehouseId: UUID,
  debitAccountId: UUID,
  creditAccountId: UUID,
}
const returnItemValid = {
  idx: 1,
  qty: '2.000000',
  deliveryItemId: UUID,
  receiptItemId: null,
  outsourcedReceiptItemId: null,
  materialId: null,
  orderPrice: '1.2000',
  orderTaxRate: '0.1300',
  unitId: UUID,
  warehouseId: null,
  remarks: '行备注',
}
const returnPayloads: Record<string, unknown> = {
  'valid-minimal': {
    companyId: UUID, partyType: 'CUSTOMER', partyId: UUID,
    items: [{ idx: 1, qty: '1', warehouseId: null }],
  },
  'valid-full': { ...returnHeadValid, items: [{ id: UUID2, ...returnItemValid }] },
  'items-omitted': { companyId: UUID, partyType: 'customer', partyId: UUID },
  'items-empty': { companyId: UUID, partyType: 'customer', partyId: UUID, items: [] },
  'unknown-key': { companyId: UUID, partyType: 'customer', partyId: UUID, items: [], bogus: 1 },
  'companyId-bad-uuid': { companyId: 'x', partyType: 'customer', partyId: UUID, items: [] },
  'partyType-empty': { companyId: UUID, partyType: '', partyId: UUID, items: [] },
  'returnDate-bad': { ...returnHeadValid, returnDate: '2026-02-30', items: [] },
  'returnDate-null': { ...returnHeadValid, returnDate: null, items: [] },
  'exchangeRate-bad': { ...returnHeadValid, exchangeRate: 'abc', items: [] },
  'exchangeRate-null': { ...returnHeadValid, exchangeRate: null, items: [] },
  'item-qty-number': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    items: [{ idx: 1, qty: 2, warehouseId: null }],
  },
  'item-qty-bad': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    items: [{ idx: 1, qty: 'abc', warehouseId: null }],
  },
  'item-warehouseId-missing': {
    companyId: UUID, partyType: 'customer', partyId: UUID, items: [{ idx: 1, qty: '1' }],
  },
  'item-idx-float': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    items: [{ idx: 1.5, qty: '1', warehouseId: null }],
  },
  'item-remarks-number': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    items: [{ idx: 1, qty: '1', warehouseId: null, remarks: 5 }],
  },
  'item-id-bad': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    items: [{ id: 'x', idx: 1, qty: '1', warehouseId: null }],
  },
  'items-not-array': { companyId: UUID, partyType: 'customer', partyId: UUID, items: 1 },
}
S['returns.draftItem'] = dumpSchema(returnDraftItem, {
  'valid-minimal': { idx: 1, qty: '1', warehouseId: null },
  'valid-full': { id: UUID2, ...returnItemValid },
  'qty-missing': { idx: 1, warehouseId: null },
  'unknown-key': { idx: 1, qty: '1', warehouseId: null, bogus: 1 },
})
S['returns.draftCreate'] = dumpSchema(returnDraftCreate, returnPayloads)
S['returns.draftReplace'] = dumpSchema(returnDraftReplace, returnPayloads)

const fulfillHeadValid = (no: string, date: string) => ({
  companyId: UUID,
  [no]: null,
  [date]: '2026-08-01',
  postingDate: null,
  partyType: 'customer',
  partyId: UUID,
  remarks: null,
  warehouseId: UUID,
  debitAccountId: UUID,
  creditAccountId: UUID,
})
const fulfillItemValid = {
  idx: 1, qty: '2.000000', orderItemId: UUID, unitId: null, warehouseId: UUID, remarks: null,
}
const salPayloads: Record<string, unknown> = {
  'valid-minimal': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID, items: [], packBoxes: [],
  },
  'valid-full': {
    ...fulfillHeadValid('deliveryNo', 'deliveryDate'),
    items: [{ id: UUID2, ...fulfillItemValid }],
    packBoxes: [{ id: UUID2, lines: [{ idx: 1, qty: '1', materialId: UUID, unitId: null, remarks: null }] }],
  },
  'packBox-no-lines': {
    ...fulfillHeadValid('deliveryNo', 'deliveryDate'), items: [], packBoxes: [{}],
  },
  'items-omitted': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID, packBoxes: [],
  },
  'debitAccountId-null': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    debitAccountId: null, creditAccountId: UUID, items: [], packBoxes: [],
  },
  'debitAccountId-missing': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    creditAccountId: UUID, items: [], packBoxes: [],
  },
  'item-orderItemId-bad': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID,
    items: [{ idx: 1, qty: '1', orderItemId: 'x', warehouseId: null }], packBoxes: [],
  },
  'partyType-empty': {
    companyId: UUID, partyType: '', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID, items: [], packBoxes: [],
  },
  'unknown-key': {
    companyId: UUID, partyType: 'customer', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID, items: [], packBoxes: [], bogus: 1,
  },
}
S['fulfillment.salesDraftCreate'] = dumpSchema(salDraftCreate, salPayloads)
S['fulfillment.salesDraftReplace'] = dumpSchema(salDraftReplace, salPayloads)

const purPayloads: Record<string, unknown> = {
  'valid-minimal': {
    companyId: UUID, partyType: 'supplier', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID, items: [],
  },
  'valid-full': { ...fulfillHeadValid('receiptNo', 'receiptDate'), items: [{ ...fulfillItemValid }] },
  'items-omitted': {
    companyId: UUID, partyType: 'supplier', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID,
  },
  'receiptNo-number': {
    companyId: UUID, receiptNo: 5, partyType: 'supplier', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID, items: [],
  },
  'item-warehouseId-missing': {
    companyId: UUID, partyType: 'supplier', partyId: UUID,
    debitAccountId: UUID, creditAccountId: UUID,
    items: [{ idx: 1, qty: '1', orderItemId: UUID }],
  },
}
S['fulfillment.purchaseDraftCreate'] = dumpSchema(purDraftCreate, purPayloads)
S['fulfillment.purchaseDraftReplace'] = dumpSchema(purDraftReplace, purPayloads)

const reconHeadValid = {
  companyId: UUID,
  reconciliationNo: null,
  reconciliationType: 'REGULAR',
  partyType: 'customer',
  partyId: UUID,
  debitAccountId: UUID,
  creditAccountId: UUID,
  remarks: null,
}
const reconItemValid = {
  idx: 1, qty: '2.000000', deliveryItemId: UUID, returnItemId: null,
  receiptItemId: null, outsourcedReceiptItemId: null, remarks: null,
}
const reconPayloads: Record<string, unknown> = {
  'valid-minimal': {
    companyId: UUID, reconciliationType: 'regular', partyType: 'customer', partyId: UUID, items: [],
  },
  'valid-full': { ...reconHeadValid, items: [{ id: UUID2, ...reconItemValid }] },
  'items-omitted': {
    companyId: UUID, reconciliationType: 'REGULAR', partyType: 'customer', partyId: UUID,
  },
  'reconciliationType-empty': {
    companyId: UUID, reconciliationType: '', partyType: 'customer', partyId: UUID, items: [],
  },
  'debitAccountId-null': { ...reconHeadValid, debitAccountId: null, items: [] },
  'unknown-key': { ...reconHeadValid, items: [], bogus: 1 },
  'item-qty-bad': {
    companyId: UUID, reconciliationType: 'REGULAR', partyType: 'customer', partyId: UUID,
    items: [{ idx: 1, qty: 'abc' }],
  },
}
S['reconciliation.draftItem'] = dumpSchema(reconDraftItem, {
  'valid-minimal': { idx: 1, qty: '1' },
  'valid-full': { id: UUID2, ...reconItemValid },
  'qty-missing': { idx: 1 },
  'unknown-key': { idx: 1, qty: '1', bogus: 1 },
})
S['reconciliation.draftCreate'] = dumpSchema(reconDraftCreate, reconPayloads)
S['reconciliation.draftReplace'] = dumpSchema(reconDraftReplace, reconPayloads)

const out = process.argv[2]
if (!out) throw new Error('用法: bun scripts/wire-equiv-dump.ts <输出.json>')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(dump, null, 1)}\n`)
console.log(`dumped → ${out}`)
