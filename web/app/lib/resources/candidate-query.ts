import type { SortState } from '~/components/synie-data-grid/types'
import type { ResourceQuery } from './types'

export interface DomainCandidateQuery {
  candidateProfile: string
  args: Record<string, string | boolean>
}

type CandidateResource =
  | 'accBankAccounts'
  | 'accBankImportTemplates'
  | 'accBillHoldings'
  | 'accVatInvoices'
  | 'salReconciliations'
  | 'purReconciliations'
  | 'salOrderItems'
  | 'purOrderItems'
  | 'purOrderItemMaterials'
  | 'salQuotationItems'
  | 'purQuotationItems'
  | 'salDeliveryItems'
  | 'purReceiptItems'
  | 'purOutsourcedReceiptItems'
  | 'mfgBoms'

const CANDIDATE_RESOURCES = new Set<CandidateResource>([
  'accBankAccounts',
  'accBankImportTemplates',
  'accBillHoldings',
  'accVatInvoices',
  'salReconciliations',
  'purReconciliations',
  'salOrderItems',
  'purOrderItems',
  'purOrderItemMaterials',
  'salQuotationItems',
  'purQuotationItems',
  'salDeliveryItems',
  'purReceiptItems',
  'purOutsourcedReceiptItems',
  'mfgBoms',
])

function unsupported(message: string): never {
  throw new Error(`此筛选/排序组合暂不支持：${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(record: Record<string, unknown> | undefined, field: string): boolean {
  return record != null && Object.prototype.hasOwnProperty.call(record, field)
}

function rawFieldValues(input: ResourceQuery, field: string): unknown[] {
  const values: unknown[] = []
  if (own(input.args, field)) values.push(input.args![field])
  if (own(input.fixedFilter, field)) values.push(input.fixedFilter![field])
  if (own(input.filter, field)) values.push(input.filter![field])
  return values
}

function queryFields(input: ResourceQuery): Set<string> {
  return new Set([
    ...Object.keys(input.args ?? {}),
    ...Object.keys(input.fixedFilter ?? {}),
    ...Object.keys(input.filter ?? {}),
  ])
}

function parseConsistent<T>(
  input: ResourceQuery,
  field: string,
  parser: (value: unknown) => T,
  required = true,
): T | undefined {
  const rawValues = rawFieldValues(input, field)
  if (rawValues.length === 0) {
    if (required) unsupported(`缺少 ${field}`)
    return undefined
  }
  const parsed = rawValues.map((value) => parser(value))
  const expected = JSON.stringify(parsed[0])
  if (parsed.some((value) => JSON.stringify(value) !== expected)) {
    unsupported(`${field} 在 args/fixedFilter/filter 中冲突`)
  }
  return parsed[0]
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  unsupported(`${field} 必须是非空字符串`)
}

function parseFk(field: string) {
  return (value: unknown): string => {
    if (typeof value === 'string') return nonEmptyString(value, field)
    if (
      isRecord(value) &&
      value.kind === 'fk' &&
      (value.op === undefined || value.op === 'in') &&
      Array.isArray(value.values) &&
      value.values.length === 1
    ) {
      return nonEmptyString(value.values[0], field)
    }
    unsupported(`${field} 仅支持单值外键`)
  }
}

interface PolyFkValue {
  variant: string
  id: string
}

function parsePolyFk(field: string) {
  return (value: unknown): PolyFkValue => {
    if (
      isRecord(value) &&
      value.kind === 'polyFk' &&
      value.op === 'in' &&
      typeof value.variant === 'string' &&
      value.variant.trim() &&
      Array.isArray(value.values) &&
      value.values.length === 1
    ) {
      return {
        variant: value.variant.trim(),
        id: nonEmptyString(value.values[0], field),
      }
    }
    unsupported(`${field} 仅支持带变体的单值多态外键`)
  }
}

function parseEnum(field: string) {
  return (value: unknown): string => {
    if (typeof value === 'string') return nonEmptyString(value, field)
    if (
      isRecord(value) &&
      value.kind === 'enum' &&
      Array.isArray(value.values) &&
      value.values.length === 1
    ) {
      return nonEmptyString(value.values[0], field)
    }
    unsupported(`${field} 仅支持单值枚举`)
  }
}

function parseBoolean(field: string) {
  return (value: unknown): boolean => {
    if (typeof value === 'boolean') return value
    if (isRecord(value) && value.kind === 'bool' && typeof value.eq === 'boolean') {
      return value.eq
    }
    unsupported(`${field} 仅支持布尔值`)
  }
}

function parseTextEquality(field: string) {
  return (value: unknown): string => {
    if (typeof value === 'string') return nonEmptyString(value, field)
    if (isRecord(value) && value.kind === 'text' && value.op === 'eq') {
      return nonEmptyString(value.value, field)
    }
    unsupported(`${field} 仅支持文本等值`)
  }
}

function parsePositiveThreshold(field: string) {
  return (value: unknown): true => {
    if (
      isRecord(value) &&
      value.kind === 'number' &&
      value.op === 'gt' &&
      typeof value.value === 'string' &&
      value.value.trim() !== '' &&
      Number(value.value) === 0
    ) {
      return true
    }
    unsupported(`${field} 必须是大于 0 的候选资格筛选`)
  }
}

function validDate(value: unknown, field: string): string {
  const date = nonEmptyString(value, field)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) unsupported(`${field} 必须是 YYYY-MM-DD`)
  return date
}

function parseDateBoundary(field: string, boundary: 'gte' | 'lte') {
  return (value: unknown): string => {
    const opposite = boundary === 'gte' ? 'lte' : 'gte'
    if (
      isRecord(value) &&
      value.kind === 'date' &&
      value.op === 'between' &&
      value[opposite] === undefined
    ) {
      return validDate(value[boundary], field)
    }
    unsupported(`${field} 必须只提供 ${boundary} 日期边界`)
  }
}

function requireValue<T>(value: T | undefined, field: string): T {
  if (value === undefined) unsupported(`缺少 ${field}`)
  return value
}

function expectLiteral<T extends string | boolean>(value: T, expected: T, field: string): void {
  if (value !== expected) unsupported(`${field} 必须是 ${String(expected)}`)
}

function expectOnlyFields(input: ResourceQuery, fields: readonly string[]): void {
  const allowed = new Set(fields)
  const extra = [...queryFields(input)].filter((field) => !allowed.has(field))
  if (extra.length > 0) unsupported(extra.join('、'))
}

function expectSort(input: ResourceQuery, expected: SortState): void {
  if (
    input.sort &&
    (input.sort.column !== expected.column || input.sort.direction !== expected.direction)
  ) {
    unsupported(`候选集仅支持 ${expected.column} ${expected.direction}`)
  }
}

function hasAnyField(input: ResourceQuery, fields: readonly string[]): boolean {
  const present = queryFields(input)
  return fields.some((field) => present.has(field))
}

function partyArgs(input: ResourceQuery): { partyType: string; partyId: string } {
  const partyType = requireValue(parseConsistent(input, 'partyType', parseEnum('partyType')), 'partyType')
  const party = requireValue(parseConsistent(input, 'partyId', parsePolyFk('partyId')), 'partyId')
  if (party.variant !== partyType) unsupported('partyId 变体必须与 partyType 一致')
  return { partyType, partyId: party.id }
}

function fixedEnum(input: ResourceQuery, field: string, expected: string): void {
  const value = requireValue(parseConsistent(input, field, parseEnum(field)), field)
  expectLiteral(value, expected, field)
}

function fixedBoolean(input: ResourceQuery, field: string, expected: boolean): void {
  const value = requireValue(parseConsistent(input, field, parseBoolean(field)), field)
  expectLiteral(value, expected, field)
}

function fixedPositive(input: ResourceQuery, field: string): void {
  parseConsistent(input, field, parsePositiveThreshold(field))
}

/**
 * 将旧页面的结构化复合筛选收敛为服务端命名候选集。
 *
 * 页面条件在这里逐项验证，Convex 只收到候选 profile 的语义参数；任何缺项、
 * 多值或额外条件均 fail-closed，不能退化成跨公司或未审核的宽查询。
 */
export function resolveDomainCandidateQuery(
  resource: string,
  input: ResourceQuery,
): DomainCandidateQuery | undefined {
  if (!CANDIDATE_RESOURCES.has(resource as CandidateResource)) return undefined

  if (resource === 'accBankAccounts') {
    if (!hasAnyField(input, ['companyId', 'active'])) return undefined
    expectOnlyFields(input, ['companyId', 'active'])
    expectSort(input, { column: 'alias', direction: 'ascending' })
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    const active = requireValue(parseConsistent(input, 'active', parseBoolean('active')), 'active')
    expectLiteral(active, true, 'active')
    return { candidateProfile: 'bankAccountActive', args: { companyId, active } }
  }

  if (resource === 'accBankImportTemplates') {
    if (!hasAnyField(input, ['bankAccountId'])) return undefined
    expectOnlyFields(input, ['bankAccountId'])
    expectSort(input, { column: 'name', direction: 'ascending' })
    const bankAccountId = requireValue(parseConsistent(input, 'bankAccountId', parseFk('bankAccountId')), 'bankAccountId')
    return { candidateProfile: 'bankImportTemplateByAccount', args: { bankAccountId } }
  }

  if (resource === 'accBillHoldings') {
    if (!hasAnyField(input, ['bankAccountId'])) return undefined
    expectOnlyFields(input, ['companyId', 'bankAccountId'])
    expectSort(input, { column: 'dueDate', direction: 'ascending' })
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    const bankAccountId = requireValue(parseConsistent(input, 'bankAccountId', parseFk('bankAccountId')), 'bankAccountId')
    return { candidateProfile: 'billHoldingByAccount', args: { companyId, bankAccountId } }
  }

  if (resource === 'accVatInvoices') {
    if (!hasAnyField(input, ['direction', 'partyType', 'partyId'])) return undefined
    expectOnlyFields(input, ['companyId', 'direction', 'partyType', 'partyId', 'status'])
    expectSort(input, { column: 'docNo', direction: 'ascending' })
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    fixedEnum(input, 'direction', 'INBOUND')
    fixedEnum(input, 'partyType', 'EMPLOYEE')
    fixedEnum(input, 'status', 'AUDITED')
    const employeeId = requireValue(parseConsistent(input, 'partyId', parseFk('partyId')), 'partyId')
    return { candidateProfile: 'expenseInvoice', args: { companyId, employeeId } }
  }

  if (resource === 'salReconciliations' || resource === 'purReconciliations') {
    if (!hasAnyField(input, ['partyType', 'partyId', 'reconciliationType'])) return undefined
    expectOnlyFields(input, ['companyId', 'partyType', 'partyId', 'status', 'reconciliationType'])
    expectSort(input, { column: 'reconciliationNo', direction: 'ascending' })
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    const partyType = requireValue(parseConsistent(input, 'partyType', parseEnum('partyType')), 'partyType')
    const partyId = requireValue(parseConsistent(input, 'partyId', parseFk('partyId')), 'partyId')
    fixedEnum(input, 'status', 'CONFIRMED')
    fixedEnum(input, 'reconciliationType', 'REGULAR')
    return {
      candidateProfile: 'invoiceReconciliation',
      args: { companyId, partyType, partyId },
    }
  }

  if (resource === 'salOrderItems' || resource === 'purOrderItems') {
    const triggers = ['orderStatus', 'partyType', 'partyId', 'remainingBaseQty', 'orderIsOutsourced']
    if (!hasAnyField(input, triggers)) return undefined
    expectOnlyFields(input, ['orderStatus', 'companyId', 'partyType', 'partyId', 'remainingBaseQty', 'orderIsOutsourced'])
    expectSort(input, { column: 'orderDate', direction: 'ascending' })
    fixedEnum(input, 'orderStatus', 'AUDITED')
    fixedPositive(input, 'remainingBaseQty')
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    const party = partyArgs(input)
    const explicitOutsourced = parseConsistent(input, 'orderIsOutsourced', parseBoolean('orderIsOutsourced'), false)
    if (resource === 'salOrderItems' && explicitOutsourced !== undefined) {
      unsupported('销售订单条目不接受 orderIsOutsourced')
    }
    return {
      candidateProfile: 'orderItemFulfillment',
      args: {
        companyId,
        ...party,
        orderIsOutsourced: explicitOutsourced ?? false,
      },
    }
  }

  if (resource === 'purOrderItemMaterials') {
    const triggers = ['orderStatus', 'orderIsOutsourced', 'partyType', 'partyId', 'remainingIssueQty']
    if (!hasAnyField(input, triggers)) return undefined
    expectOnlyFields(input, ['orderStatus', 'orderIsOutsourced', 'companyId', 'partyType', 'partyId', 'remainingIssueQty'])
    expectSort(input, { column: 'orderNo', direction: 'ascending' })
    fixedEnum(input, 'orderStatus', 'AUDITED')
    fixedBoolean(input, 'orderIsOutsourced', true)
    fixedPositive(input, 'remainingIssueQty')
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    return {
      candidateProfile: 'outsourcedMaterialIssue',
      args: { companyId, ...partyArgs(input) },
    }
  }

  if (resource === 'salQuotationItems' || resource === 'purQuotationItems') {
    const triggers = ['quotationStatus', 'partyType', 'partyId', 'currencyId', 'quotationDate', 'validUntil']
    if (!hasAnyField(input, triggers)) return undefined
    expectOnlyFields(input, ['quotationStatus', 'companyId', 'partyType', 'partyId', 'currencyId', 'quotationDate', 'validUntil'])
    expectSort(input, { column: 'materialCode', direction: 'ascending' })
    fixedEnum(input, 'quotationStatus', 'AUDITED')
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    const currencyId = requireValue(parseConsistent(input, 'currencyId', parseFk('currencyId')), 'currencyId')
    const quotationDate = requireValue(
      parseConsistent(input, 'quotationDate', parseDateBoundary('quotationDate', 'lte')),
      'quotationDate',
    )
    const validUntil = requireValue(
      parseConsistent(input, 'validUntil', parseDateBoundary('validUntil', 'gte')),
      'validUntil',
    )
    if (quotationDate !== validUntil) unsupported('报价有效区间必须使用同一个订单日期')
    return {
      candidateProfile: 'quotationItemValid',
      args: { companyId, ...partyArgs(input), currencyId, orderDate: quotationDate },
    }
  }

  if (
    resource === 'salDeliveryItems' ||
    resource === 'purReceiptItems' ||
    resource === 'purOutsourcedReceiptItems'
  ) {
    const statusField = resource === 'salDeliveryItems' ? 'deliveryStatus' : 'receiptStatus'
    const remainingField = 'remainingReconcilableQty'
    const triggers = [statusField, 'partyType', 'partyId', remainingField, 'orderCurrencyCode', 'orderPrice', 'orderType']
    if (!hasAnyField(input, triggers)) return undefined
    expectOnlyFields(input, [
      statusField,
      'companyId',
      'partyType',
      'partyId',
      remainingField,
      'reconciliationType',
      'orderCurrencyCode',
      'orderPrice',
      'orderType',
    ])
    expectSort(input, {
      column: resource === 'salDeliveryItems' ? 'deliveryDate' : 'receiptDate',
      direction: 'ascending',
    })
    fixedEnum(input, statusField, 'AUDITED')
    fixedPositive(input, remainingField)
    const companyId = requireValue(parseConsistent(input, 'companyId', parseFk('companyId')), 'companyId')
    const reconciliationType = requireValue(
      parseConsistent(input, 'reconciliationType', parseEnum('reconciliationType')),
      'reconciliationType',
    )
    if (reconciliationType !== 'REGULAR' && reconciliationType !== 'GIFT_SAMPLE') {
      unsupported('reconciliationType 仅支持 REGULAR 或 GIFT_SAMPLE')
    }
    if (reconciliationType === 'REGULAR') {
      fixedPositive(input, 'orderPrice')
      if (resource === 'salDeliveryItems') fixedEnum(input, 'orderType', 'REGULAR')
      else if (hasAnyField(input, ['orderType'])) unsupported('采购入库条目不接受 orderType')
    } else if (hasAnyField(input, ['orderPrice', 'orderType'])) {
      unsupported('GIFT_SAMPLE 候选不得携带价格或订单类型资格条件')
    }
    const orderCurrencyCode = parseConsistent(
      input,
      'orderCurrencyCode',
      parseTextEquality('orderCurrencyCode'),
      false,
    )
    return {
      candidateProfile: 'reconciliationLine',
      args: {
        companyId,
        ...partyArgs(input),
        reconciliationType,
        ...(orderCurrencyCode === undefined ? {} : { orderCurrencyCode }),
      },
    }
  }

  if (resource === 'mfgBoms') {
    if (!hasAnyField(input, ['materialId'])) return undefined
    expectOnlyFields(input, ['materialId', 'status'])
    expectSort(input, { column: 'code', direction: 'ascending' })
    const materialId = requireValue(parseConsistent(input, 'materialId', parseFk('materialId')), 'materialId')
    const status = parseConsistent(input, 'status', parseEnum('status'), false)
    if (status !== undefined) expectLiteral(status, 'ACTIVE', 'status')
    return {
      candidateProfile: 'bomByMaterial',
      args: { materialId, ...(status === undefined ? {} : { status }) },
    }
  }

  return undefined
}
