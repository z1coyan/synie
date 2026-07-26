import { apiClient, apiData } from '../api/client'
import type { components } from '../api/schema'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = components['schemas']['FilterState']

function queryBody(input: ResourceQuery) {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: {
      ...(input.filter ?? {}),
      ...((input.fixedFilter ?? {}) as FilterState),
    } as FilterDocument,
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

function decimalInput(input: Record<string, unknown>, fields: readonly string[]) {
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

async function salesAction(
  id: string,
  action: 'confirm' | 'unconfirm' | 'audit' | 'void',
) {
  if (action === 'confirm') {
    return apiData(
      apiClient.POST('/sales/reconciliations/{id}/confirm', {
        params: { path: { id } },
      }),
    )
  }
  if (action === 'unconfirm') {
    return apiData(
      apiClient.POST('/sales/reconciliations/{id}/unconfirm', {
        params: { path: { id } },
      }),
    )
  }
  if (action === 'audit') {
    return apiData(
      apiClient.POST('/sales/reconciliations/{id}/audit', {
        params: { path: { id } },
      }),
    )
  }
  return apiData(
    apiClient.POST('/sales/reconciliations/{id}/void', {
      params: { path: { id } },
    }),
  )
}

async function purchaseAction(
  id: string,
  action: 'confirm' | 'unconfirm' | 'audit' | 'void',
) {
  if (action === 'confirm') {
    return apiData(
      apiClient.POST('/purchase/reconciliations/{id}/confirm', {
        params: { path: { id } },
      }),
    )
  }
  if (action === 'unconfirm') {
    return apiData(
      apiClient.POST('/purchase/reconciliations/{id}/unconfirm', {
        params: { path: { id } },
      }),
    )
  }
  if (action === 'audit') {
    return apiData(
      apiClient.POST('/purchase/reconciliations/{id}/audit', {
        params: { path: { id } },
      }),
    )
  }
  return apiData(
    apiClient.POST('/purchase/reconciliations/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export const salesReconciliationClient = resourceClient('salReconciliations', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/sales/reconciliations/query', { body: queryBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/sales/reconciliations/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/sales/reconciliations', { body: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/sales/reconciliations/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/sales/reconciliations/{id}', {
        params: { path: { id } },
      }),
    )
  },
  async action(key, ids) {
    if (!['confirm', 'unconfirm', 'audit', 'void'].includes(key)) {
      throw new Error(`销售对账单 REST Client 未实现动作 ${key}`)
    }
    for (const id of ids) {
      await salesAction(
        id,
        key as 'confirm' | 'unconfirm' | 'audit' | 'void',
      )
    }
  },
})

export const salesReconciliationItemClient = resourceClient(
  'salReconciliationItems',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/sales/reconciliation-items/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/sales/reconciliation-items/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/sales/reconciliation-items', {
          body: decimalInput(input, ['qty']) as never,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/sales/reconciliation-items/{id}', {
          params: { path: { id } },
          body: decimalInput(input, ['qty']) as never,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/sales/reconciliation-items/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const purchaseReconciliationClient = resourceClient(
  'purReconciliations',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/reconciliations/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/reconciliations/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/reconciliations', { body: input as never }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/reconciliations/{id}', {
          params: { path: { id } },
          body: input as never,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/reconciliations/{id}', {
          params: { path: { id } },
        }),
      )
    },
    async action(key, ids) {
      if (!['confirm', 'unconfirm', 'audit', 'void'].includes(key)) {
        throw new Error(`采购对账单 REST Client 未实现动作 ${key}`)
      }
      for (const id of ids) {
        await purchaseAction(
          id,
          key as 'confirm' | 'unconfirm' | 'audit' | 'void',
        )
      }
    },
  },
)

export const purchaseReconciliationItemClient = resourceClient(
  'purReconciliationItems',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/purchase/reconciliation-items/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/purchase/reconciliation-items/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/purchase/reconciliation-items', {
          body: decimalInput(input, ['qty']) as never,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/purchase/reconciliation-items/{id}', {
          params: { path: { id } },
          body: decimalInput(input, ['qty']) as never,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/purchase/reconciliation-items/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const companyAccountDefaultClient = resourceClient(
  'salCompanyAccountDefaults',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/sales/company-account-defaults/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/sales/company-account-defaults/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/sales/company-account-defaults', {
          body: input as never,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/sales/company-account-defaults/{id}', {
          params: { path: { id } },
          body: input as never,
        }),
      )) as Row
    },
    async delete() {
      throw new Error('公司默认过账科目不支持删除；清配置请将四个科目槽更新为空')
    },
  },
)

export const orderFlowItemClient = resourceClient('scmOrderFlowItems', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/scm/order-flow-items/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/scm/order-flow-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create() {
    throw new Error('订单收发货历史为只读资源')
  },
  async update() {
    throw new Error('订单收发货历史为只读资源')
  },
  async delete() {
    throw new Error('订单收发货历史为只读资源')
  },
})
