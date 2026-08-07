import { describe, expect, test } from 'bun:test'
import {
  buildDeliveryDraft,
  headerFieldErrors,
  rowErrors,
} from './sales-delivery-draft'
import {
  createSalesDeliveryDraftAdapter,
  type SalesDeliveryDraftGateway,
  type SalesDeliveryDraftInput,
  type SalesDeliveryDraftPackBoxInput,
  type SalesDeliverySavedDraft,
} from './fulfillment'

type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true
type Assert<T extends true> = T

const requiredCollectionContract: [
  Assert<IsRequired<SalesDeliveryDraftInput, 'items'>>,
  Assert<IsRequired<SalesDeliveryDraftInput, 'packBoxes'>>,
  Assert<IsRequired<SalesDeliveryDraftPackBoxInput, 'lines'>>,
] = [true, true, true]

const header = {
  companyId: 'company-1',
  deliveryNo: 'SD-1',
  deliveryDate: '2026-07-31',
  postingDate: null,
  partyType: 'CUSTOMER',
  partyId: 'customer-1',
  remarks: null,
  warehouseId: 'warehouse-1',
  debitAccountId: 'debit-1',
  creditAccountId: 'credit-1',
}

function recordingGateway() {
  const requests: Array<{
    operation: 'create' | 'replace'
    id?: string
    input: SalesDeliveryDraftInput
  }> = []
  const saved = (
    id: string,
    input: SalesDeliveryDraftInput,
  ): SalesDeliverySavedDraft => ({
    ...input,
    id,
    status: 'DRAFT',
  }) as unknown as SalesDeliverySavedDraft
  const gateway: SalesDeliveryDraftGateway = {
    async loadDraft() {
      throw new Error('本测试不读取草稿')
    },
    async createDraft(input) {
      requests.push({ operation: 'create', input })
      return saved('delivery-created', input)
    },
    async replaceDraft(id, input) {
      requests.push({ operation: 'replace', id, input })
      return saved(id, input)
    },
  }
  return { gateway, requests }
}

describe('销售发货 Aggregate Draft wire contract', () => {
  test('类型接口要求 items、packBoxes 与每箱 lines 都显式存在', () => {
    expect(requiredCollectionContract).toEqual([true, true, true])
    const complete = {
      ...header,
      items: [],
      packBoxes: [{ lines: [] }],
    } satisfies SalesDeliveryDraftInput
    expect(complete.packBoxes[0]?.lines).toEqual([])
  })

  test('缺失或非数组集合在 gateway 请求前 fail-closed', async () => {
    const { gateway, requests } = recordingGateway()
    const adapter = createSalesDeliveryDraftAdapter(gateway)
    const cases: Array<{
      input: unknown
      field: RegExp
    }> = [
      {
        input: { ...header, packBoxes: [] },
        field: /items 必须显式提交数组/,
      },
      {
        input: { ...header, items: {}, packBoxes: [] },
        field: /items 必须显式提交数组/,
      },
      {
        input: { ...header, items: [] },
        field: /packBoxes 必须显式提交数组/,
      },
      {
        input: { ...header, items: [], packBoxes: null },
        field: /packBoxes 必须显式提交数组/,
      },
      {
        input: { ...header, items: [], packBoxes: [{}] },
        field: /packBoxes\[0\]\.lines 必须显式提交数组/,
      },
      {
        input: { ...header, items: [], packBoxes: [{ lines: 'all' }] },
        field: /packBoxes\[0\]\.lines 必须显式提交数组/,
      },
    ]

    for (const invalid of cases) {
      for (const operation of ['create', 'replace'] as const) {
        const input = invalid.input as SalesDeliveryDraftInput
        const request = operation === 'create'
          ? adapter.createDraft(input)
          : adapter.replaceDraft('delivery-1', input)
        await expect(request).rejects.toThrow(invalid.field)
        expect(requests).toHaveLength(0)
      }
    }
  })

  test('显式完整空数组可由 create 与 replace 发送并清空子树', async () => {
    const { gateway, requests } = recordingGateway()
    const adapter = createSalesDeliveryDraftAdapter(gateway)
    const emptyDraft: SalesDeliveryDraftInput = {
      ...header,
      items: [],
      packBoxes: [],
    }

    await adapter.createDraft(emptyDraft)
    await adapter.replaceDraft('delivery-1', emptyDraft)

    expect(requests).toEqual([
      { operation: 'create', input: emptyDraft },
      { operation: 'replace', id: 'delivery-1', input: emptyDraft },
    ])
  })
})

describe('buildDeliveryDraft（表单态 → wire）', () => {
  const values = {
    companyId: 'company-1',
    deliveryNo: '',
    deliveryDate: '2026-08-08',
    postingDate: null,
    partyType: 'CUSTOMER',
    partyId: 'customer-1',
    remarks: '  ',
    warehouseId: null,
    debitAccountId: 'debit-1',
    creditAccountId: 'credit-1',
  }
  const items = [
    { id: 'item-1', idx: 1, orderItemId: 'order-item-1', unitId: 'u-1', qty: '2', warehouseId: 'wh-1', remarks: null },
  ]
  const boxes = [{ id: 'box-1' }, { id: 'box-2' }]
  const lines = [
    { id: 'line-1', packBoxId: 'box-1', idx: 1, materialId: 'm-1', unitId: 'u-1', qty: '1', remarks: null },
    { id: 'line-2', packBoxId: 'box-2', idx: 1, materialId: 'm-2', unitId: null, qty: '3', remarks: null },
  ]

  test('装箱行按所属箱分组嵌套，行 id 索引与嵌套层级同序', () => {
    const { draft, index } = buildDeliveryDraft(values, items, boxes, lines)
    expect(draft.items).toHaveLength(1)
    expect(draft.packBoxes.map((b) => b.lines.map((l) => l.id))).toEqual([['line-1'], ['line-2']])
    expect(index).toEqual({ itemRowIds: ['item-1'], boxRowIds: ['box-1', 'box-2'], lineRowIds: [['line-1'], ['line-2']] })
  })

  test('空串/null 头字段归一为 null，必填缺失在行级报错', () => {
    const { draft } = buildDeliveryDraft(values, items, boxes, lines)
    expect(draft.deliveryNo).toBeNull()
    expect(() => buildDeliveryDraft(values, [{ ...items[0]!, qty: '' }], boxes, lines)).toThrow('发货数量不能为空')
  })
})

describe('草稿错误路径映射', () => {
  test('header.* 前缀剥离，子集合路径不进头字段错误', () => {
    const result = headerFieldErrors({
      'header.debitAccountId': ['必填'],
      'items[0].qty': ['必须大于 0'],
      'packBoxes[1].lines[0].qty': ['必须大于 0'],
    })
    expect(result).toEqual({ debitAccountId: ['必填'] })
  })

  test('行错误按索引解析回行 id，点号与方括号索引同口径', () => {
    const rows = [{ id: 'row-a' }, { id: 'row-b' }]
    const result = rowErrors(
      { 'items.1.qty': ['必须大于 0'], 'items[0].qty': ['必填'], 'header.remarks': ['忽略'] },
      /^items\[(\d+)\](?:\.(.+))?$/,
      (i) => rows[i],
    )
    expect(result).toEqual({ 'row-b': ['qty: 必须大于 0'], 'row-a': ['qty: 必填'] })
  })
})
