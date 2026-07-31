import { describe, expect, test } from 'bun:test'
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
