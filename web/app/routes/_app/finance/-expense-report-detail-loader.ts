import type { Row } from '~/components/synie-data-grid/types'

export interface ExpenseDetailRequest {
  generation: number
  documentId: string
}

export interface LoadedExpenseDetail {
  rows: Row[]
  invoiceCache: Map<string, Row>
}

export function isCurrentExpenseDetailRequest(
  active: ExpenseDetailRequest | null,
  request: ExpenseDetailRequest,
): boolean {
  return (
    active?.generation === request.generation &&
    active.documentId === request.documentId
  )
}

/**
 * 报销聚合与发票快照分两段异步读取；每段完成后以及提交 UI 结果前都重验请求身份。
 * 回调是唯一允许写组件 state/ref 的出口，因此旧抽屉请求不能污染后来打开的单据。
 */
export async function loadExpenseDetailForRequest(input: {
  request: ExpenseDetailRequest
  activeRequest: () => ExpenseDetailRequest | null
  loadDraft: (documentId: string) => Promise<{ items: Row[] }>
  loadInvoice: (invoiceId: string) => Promise<Row | null>
  onLoaded: (detail: LoadedExpenseDetail) => void
  onError: (error: unknown) => void
}): Promise<'loaded' | 'error' | 'stale'> {
  const current = () =>
    isCurrentExpenseDetailRequest(input.activeRequest(), input.request)

  try {
    const draft = await input.loadDraft(input.request.documentId)
    if (!current()) return 'stale'

    const invoices = await Promise.all(
      draft.items.map((item) =>
        item.invoiceId
          ? input.loadInvoice(String(item.invoiceId)).catch(() => null)
          : Promise.resolve(null),
      ),
    )
    if (!current()) return 'stale'

    const invoiceCache = new Map<string, Row>()
    const rows = draft.items.map((item, index) => {
      const invoice = invoices[index]
      if (invoice && item.invoiceId) {
        invoiceCache.set(String(item.invoiceId), invoice)
      }
      return {
        ...item,
        invoice,
        invoiceGrossTotal: invoice?.grossTotal ?? null,
      }
    })

    // 映射本身虽同步，仍在唯一 state/ref 写出口前做最后一次身份确认。
    if (!current()) return 'stale'
    input.onLoaded({ rows, invoiceCache })
    return 'loaded'
  } catch (error) {
    if (!current()) return 'stale'
    input.onError(error)
    return 'error'
  }
}
