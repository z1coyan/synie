import { apiClient, apiData } from '../api/client'
import type { components } from '../api/schema'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = components['schemas']['FilterState']
type FulfillmentAuditRequest = components['schemas']['FulfillmentAuditRequest']
type CompanyAccountDefaults = components['schemas']['CompanyAccountDefaults']
type SalesDeliveryCreate = components['schemas']['SalesDeliveryCreate']
type SalesDeliveryUpdate = components['schemas']['SalesDeliveryUpdate']
type SalesDeliveryItemCreate = components['schemas']['SalesDeliveryItemCreate']
type SalesDeliveryItemUpdate = components['schemas']['SalesDeliveryItemUpdate']
type PurchaseReceiptCreate = components['schemas']['PurchaseReceiptCreate']
type PurchaseReceiptUpdate = components['schemas']['PurchaseReceiptUpdate']
type PurchaseReceiptItemCreate =
  components['schemas']['PurchaseReceiptItemCreate']
type PurchaseReceiptItemUpdate =
  components['schemas']['PurchaseReceiptItemUpdate']
type PurchaseOutsourcedIssueCreate =
  components['schemas']['PurchaseOutsourcedIssueCreate']
type PurchaseOutsourcedIssueUpdate =
  components['schemas']['PurchaseOutsourcedIssueUpdate']
type PurchaseOutsourcedIssueItemCreate =
  components['schemas']['PurchaseOutsourcedIssueItemCreate']
type PurchaseOutsourcedIssueItemUpdate =
  components['schemas']['PurchaseOutsourcedIssueItemUpdate']
type PurchaseOutsourcedReceiptCreate =
  components['schemas']['PurchaseOutsourcedReceiptCreate']
type PurchaseOutsourcedReceiptUpdate =
  components['schemas']['PurchaseOutsourcedReceiptUpdate']
type PurchaseOutsourcedReceiptItemCreate =
  components['schemas']['PurchaseOutsourcedReceiptItemCreate']
type PurchaseOutsourcedReceiptItemUpdate =
  components['schemas']['PurchaseOutsourcedReceiptItemUpdate']
type PurchaseOutsourcedReceiptItemMaterialCreate =
  components['schemas']['PurchaseOutsourcedReceiptItemMaterialCreate']
type PurchaseOutsourcedReceiptItemMaterialUpdate =
  components['schemas']['PurchaseOutsourcedReceiptItemMaterialUpdate']
type PurchaseOutsourcedReceiptItemByproductCreate =
  components['schemas']['PurchaseOutsourcedReceiptItemByproductCreate']
type PurchaseOutsourcedReceiptItemByproductUpdate =
  components['schemas']['PurchaseOutsourcedReceiptItemByproductUpdate']

function queryBody(input: ResourceQuery) {
  const filter = {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  }
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: filter as FilterDocument,
  }
}

async function meta(resource: string) {
  return gridMeta(
    await apiData(
      apiClient.GET('/meta/resources/{name}', {
        params: { path: { name: resource } },
      }),
    ),
  )
}

function decimalInput(
  input: Record<string, unknown>,
  fields: readonly string[],
) {
  const result = { ...input }
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue
    const value = input[field]
    result[field] = value == null || value === '' ? null : String(value)
  }
  return result
}

function resourceClient(
  resource: string,
  operations: Omit<ResourceClient, 'id' | 'meta'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
    meta: () => meta(resource),
    ...operations,
  }
}

export async function fetchSalesCompanyAccountDefaults(
  companyId: string,
): Promise<CompanyAccountDefaults | null> {
  try {
    return await apiData(
      apiClient.GET('/sales/company-account-defaults/by-company/{companyId}', {
        params: { path: { companyId } },
      }),
    )
  } catch {
    return null
  }
}

export async function auditSalesDelivery(
  id: string,
  input?: FulfillmentAuditRequest,
) {
  return apiData(
    apiClient.POST('/sales/deliveries/{id}/audit', {
      params: { path: { id } },
      body: input,
    }),
  )
}

export async function voidSalesDelivery(id: string) {
  return apiData(
    apiClient.POST('/sales/deliveries/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export async function auditPurchaseReceipt(
  id: string,
  input?: FulfillmentAuditRequest,
) {
  return apiData(
    apiClient.POST('/purchase/receipts/{id}/audit', {
      params: { path: { id } },
      body: input,
    }),
  )
}

export async function voidPurchaseReceipt(id: string) {
  return apiData(
    apiClient.POST('/purchase/receipts/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export async function auditPurchaseOutsourcedIssue(id: string) {
  return apiData(
    apiClient.POST('/purchase/outsourced-issues/{id}/audit', {
      params: { path: { id } },
    }),
  )
}

export async function voidPurchaseOutsourcedIssue(id: string) {
  return apiData(
    apiClient.POST('/purchase/outsourced-issues/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export async function auditPurchaseOutsourcedReceipt(
  id: string,
  input?: FulfillmentAuditRequest,
) {
  return apiData(
    apiClient.POST('/purchase/outsourced-receipts/{id}/audit', {
      params: { path: { id } },
      body: input,
    }),
  )
}

export async function voidPurchaseOutsourcedReceipt(id: string) {
  return apiData(
    apiClient.POST('/purchase/outsourced-receipts/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export const salesDeliveryClient = resourceClient('salDeliveries', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/deliveries/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/deliveries/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/deliveries', {
        body: input as SalesDeliveryCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/deliveries/{id}', {
        params: { path: { id } },
        body: input as SalesDeliveryUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/deliveries/{id}', {
        params: { path: { id } },
      }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditSalesDelivery(id)
      else if (key === 'void') await voidSalesDelivery(id)
      else throw new Error(`销售发货单 REST Client 未实现动作 ${key}`)
    }
  },
})

export const salesDeliveryItemClient = resourceClient('salDeliveryItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/delivery-items/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/delivery-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/delivery-items', {
        body: decimalInput(input, ['qty']) as SalesDeliveryItemCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/delivery-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['qty']) as SalesDeliveryItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/delivery-items/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const purchaseReceiptClient = resourceClient('purReceipts', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/receipts/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/receipts/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/receipts', {
        body: input as PurchaseReceiptCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/receipts/{id}', {
        params: { path: { id } },
        body: input as PurchaseReceiptUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/receipts/{id}', {
        params: { path: { id } },
      }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditPurchaseReceipt(id)
      else if (key === 'void') await voidPurchaseReceipt(id)
      else throw new Error(`采购入库单 REST Client 未实现动作 ${key}`)
    }
  },
})

export const purchaseReceiptItemClient = resourceClient('purReceiptItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/purchase/receipt-items/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/purchase/receipt-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/purchase/receipt-items', {
        body: decimalInput(input, ['qty']) as PurchaseReceiptItemCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/purchase/receipt-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['qty']) as PurchaseReceiptItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/purchase/receipt-items/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const purchaseOutsourcedIssueClient = resourceClient(
  'purOutsourcedIssues',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/outsourced-issues/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/outsourced-issues/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/outsourced-issues', {
          body: input as PurchaseOutsourcedIssueCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/outsourced-issues/{id}', {
          params: { path: { id } },
          body: input as PurchaseOutsourcedIssueUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/outsourced-issues/{id}', {
          params: { path: { id } },
        }),
      )
    },
    async action(key, ids) {
      for (const id of ids) {
        if (key === 'audit') await auditPurchaseOutsourcedIssue(id)
        else if (key === 'void') await voidPurchaseOutsourcedIssue(id)
        else throw new Error(`委外发料单 REST Client 未实现动作 ${key}`)
      }
    },
  },
)

export const purchaseOutsourcedIssueItemClient = resourceClient(
  'purOutsourcedIssueItems',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/outsourced-issue-items/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/outsourced-issue-items/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/outsourced-issue-items', {
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedIssueItemCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/outsourced-issue-items/{id}', {
          params: { path: { id } },
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedIssueItemUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/outsourced-issue-items/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const purchaseOutsourcedReceiptClient = resourceClient(
  'purOutsourcedReceipts',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/outsourced-receipts/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/outsourced-receipts/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/outsourced-receipts', {
          body: input as PurchaseOutsourcedReceiptCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/outsourced-receipts/{id}', {
          params: { path: { id } },
          body: input as PurchaseOutsourcedReceiptUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/outsourced-receipts/{id}', {
          params: { path: { id } },
        }),
      )
    },
    async action(key, ids) {
      for (const id of ids) {
        if (key === 'audit') await auditPurchaseOutsourcedReceipt(id)
        else if (key === 'void') await voidPurchaseOutsourcedReceipt(id)
        else throw new Error(`委外入库单 REST Client 未实现动作 ${key}`)
      }
    },
  },
)

export const purchaseOutsourcedReceiptItemClient = resourceClient(
  'purOutsourcedReceiptItems',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/outsourced-receipt-items/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/outsourced-receipt-items/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/outsourced-receipt-items', {
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedReceiptItemCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/outsourced-receipt-items/{id}', {
          params: { path: { id } },
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedReceiptItemUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/outsourced-receipt-items/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const purchaseOutsourcedReceiptItemMaterialClient = resourceClient(
  'purOutsourcedReceiptItemMaterials',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/outsourced-receipt-item-materials/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/outsourced-receipt-item-materials/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/outsourced-receipt-item-materials', {
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedReceiptItemMaterialCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/outsourced-receipt-item-materials/{id}', {
          params: { path: { id } },
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedReceiptItemMaterialUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/outsourced-receipt-item-materials/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const purchaseOutsourcedReceiptItemByproductClient = resourceClient(
  'purOutsourcedReceiptItemByproducts',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/outsourced-receipt-item-byproducts/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/outsourced-receipt-item-byproducts/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/outsourced-receipt-item-byproducts', {
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedReceiptItemByproductCreate,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/outsourced-receipt-item-byproducts/{id}', {
          params: { path: { id } },
          body: decimalInput(input, [
            'qty',
          ]) as PurchaseOutsourcedReceiptItemByproductUpdate,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/outsourced-receipt-item-byproducts/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)
