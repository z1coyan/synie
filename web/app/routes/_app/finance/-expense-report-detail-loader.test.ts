import { describe, expect, test } from 'bun:test'
import type { Row } from '~/components/synie-data-grid/types'
import {
  loadExpenseDetailForRequest,
  type ExpenseDetailRequest,
} from './-expense-report-detail-loader'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('expense report detail request generation', () => {
  test('旧单 A 的发票迟到后不得覆盖或标记新单 B', async () => {
    const requestA = { generation: 1, documentId: 'report-a' }
    const requestB = { generation: 2, documentId: 'report-b' }
    let active: ExpenseDetailRequest | null = requestA
    const invoiceA = deferred<Row | null>()
    const invoiceAStarted = deferred<void>()
    const applied: string[] = []
    const errors: string[] = []

    const loadingA = loadExpenseDetailForRequest({
      request: requestA,
      activeRequest: () => active,
      loadDraft: async () => ({
        items: [{ id: 'item-a', invoiceId: 'invoice-a' }],
      }),
      loadInvoice: () => {
        invoiceAStarted.resolve()
        return invoiceA.promise
      },
      onLoaded: () => applied.push('report-a'),
      onError: () => errors.push('report-a'),
    })

    await invoiceAStarted.promise
    active = requestB
    const loadingB = loadExpenseDetailForRequest({
      request: requestB,
      activeRequest: () => active,
      loadDraft: async () => ({
        items: [{ id: 'item-b', invoiceId: 'invoice-b' }],
      }),
      loadInvoice: async () => ({ id: 'invoice-b', grossTotal: '20.00' }),
      onLoaded: ({ rows }) => applied.push(String(rows[0]?.id)),
      onError: () => errors.push('report-b'),
    })

    await expect(loadingB).resolves.toBe('loaded')
    invoiceA.resolve({ id: 'invoice-a', grossTotal: '10.00' })
    await expect(loadingA).resolves.toBe('stale')
    expect(applied).toEqual(['item-b'])
    expect(errors).toEqual([])
  })

  test('同一单据重新打开也以 generation 隔离旧失败', async () => {
    const oldRequest = { generation: 3, documentId: 'report-a' }
    const newRequest = { generation: 4, documentId: 'report-a' }
    let active: ExpenseDetailRequest | null = oldRequest
    const draftA = deferred<{ items: Row[] }>()
    let errorCalls = 0

    const loading = loadExpenseDetailForRequest({
      request: oldRequest,
      activeRequest: () => active,
      loadDraft: () => draftA.promise,
      loadInvoice: async () => null,
      onLoaded: () => {
        throw new Error('旧请求不应写入')
      },
      onError: () => {
        errorCalls += 1
      },
    })

    active = newRequest
    draftA.reject(new Error('旧请求失败'))
    await expect(loading).resolves.toBe('stale')
    expect(errorCalls).toBe(0)
  })
})
