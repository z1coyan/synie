import type { components } from '../api/schema'
import { apiClient, apiData } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type MaterialCategoryCreate = components['schemas']['MaterialCategoryCreate']
type MaterialCategoryUpdate = components['schemas']['MaterialCategoryUpdate']
type MaterialCreate = components['schemas']['MaterialCreate']
type MaterialUpdate = components['schemas']['MaterialUpdate']
type MaterialUnitCreate = components['schemas']['MaterialUnitCreate']
type MaterialUnitUpdate = components['schemas']['MaterialUnitUpdate']
type WarehouseCreate = components['schemas']['WarehouseCreate']
type WarehouseUpdate = components['schemas']['WarehouseUpdate']
type WarehouseOutsourcedQuery = components['schemas']['WarehouseOutsourcedQuery']
type StockDocCreate = components['schemas']['StockDocCreate']
type StockDocUpdate = components['schemas']['StockDocUpdate']
type StockDocItemCreate = components['schemas']['StockDocItemCreate']
type StockDocItemUpdate = components['schemas']['StockDocItemUpdate']
type StockTransferCreate = components['schemas']['StockTransferCreate']
type StockTransferUpdate = components['schemas']['StockTransferUpdate']
type StockTransferItemCreate = components['schemas']['StockTransferItemCreate']
type StockTransferItemUpdate = components['schemas']['StockTransferItemUpdate']
type StockTransferReceive = components['schemas']['StockTransferReceive']
type StockCountCreate = components['schemas']['StockCountCreate']
type StockCountUpdate = components['schemas']['StockCountUpdate']
type StockCountItemCreate = components['schemas']['StockCountItemCreate']
type StockCountItemUpdate = components['schemas']['StockCountItemUpdate']
type StockBalanceQuery = components['schemas']['StockBalanceQuery']

function queryFilter(input: ResourceQuery): FilterState {
  return {
    ...(input.filter ?? {}),
    ...((input.fixedFilter ?? {}) as FilterState),
  }
}

function listBody(input: ResourceQuery) {
  return {
    limit: input.limit,
    offset: input.offset,
    search: input.search || undefined,
    sort: input.sort ?? undefined,
    filter: queryFilter(input) as components['schemas']['FilterState'],
  }
}

function apiDateTime(value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00Z`
  }
  return value
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

export const materialCategoryClient: ResourceClient = {
  id: 'rest:invMaterialCategories',
  meta: () => meta('invMaterialCategories'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/material-categories/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as components['schemas']['FilterState'],
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/material-categories/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/material-categories', { body: input as MaterialCategoryCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/material-categories/{id}', {
        params: { path: { id } },
        body: input as MaterialCategoryUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/material-categories/{id}', { params: { path: { id } } }),
    )
  },
}

export const materialClient: ResourceClient = {
  id: 'rest:invMaterials',
  meta: () => meta('invMaterials'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/materials/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as components['schemas']['FilterState'],
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/materials/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/materials', { body: input as MaterialCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/materials/{id}', {
        params: { path: { id } },
        body: input as MaterialUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/materials/{id}', { params: { path: { id } } }),
    )
  },
}

export const materialUnitClient: ResourceClient = {
  id: 'rest:invMaterialUnits',
  meta: () => meta('invMaterialUnits'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/material-units/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as components['schemas']['FilterState'],
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/material-units/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/material-units', { body: input as MaterialUnitCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/material-units/{id}', {
        params: { path: { id } },
        body: input as MaterialUnitUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/material-units/{id}', { params: { path: { id } } }),
    )
  },
}

export const warehouseClient: ResourceClient = {
  id: 'rest:invWarehouses',
  meta: () => meta('invWarehouses'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/warehouses/query', {
        body: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as components['schemas']['FilterState'],
        },
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/warehouses/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/warehouses', { body: input as WarehouseCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/warehouses/{id}', {
        params: { path: { id } },
        body: input as WarehouseUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/warehouses/{id}', { params: { path: { id } } }),
    )
  },
}

function readonlyMutation(resource: string): never {
  throw new Error(`${resource} 是只读资源`)
}

export const stockEntryClient: ResourceClient = {
  id: 'rest:invStockEntries',
  meta: () => meta('invStockEntries'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-entries/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-entries/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create() {
    return readonlyMutation('库存分录')
  },
  async update() {
    return readonlyMutation('库存分录')
  },
  async delete() {
    readonlyMutation('库存分录')
  },
}

export const stockDocClient: ResourceClient = {
  id: 'rest:invStockDocs',
  meta: () => meta('invStockDocs'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-docs/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-docs/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/stock-docs', {
        body: { ...input, docDate: apiDateTime(input.docDate) } as StockDocCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/stock-docs/{id}', {
        params: { path: { id } },
        body: { ...input, docDate: apiDateTime(input.docDate) } as StockDocUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/stock-docs/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') {
        await apiData(apiClient.POST('/inventory/stock-docs/{id}/audit', { params: { path: { id } } }))
      } else if (key === 'void') {
        await apiData(apiClient.POST('/inventory/stock-docs/{id}/void', { params: { path: { id } } }))
      } else {
        throw new Error(`库存出入库单不支持动作 ${key}`)
      }
    }
  },
}

export const stockDocItemClient: ResourceClient = {
  id: 'rest:invStockDocItems',
  meta: () => meta('invStockDocItems'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-doc-items/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-doc-items/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/stock-doc-items', { body: input as StockDocItemCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/stock-doc-items/{id}', {
        params: { path: { id } },
        body: input as StockDocItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/stock-doc-items/{id}', { params: { path: { id } } }),
    )
  },
}

export const stockTransferClient: ResourceClient = {
  id: 'rest:invStockTransfers',
  meta: () => meta('invStockTransfers'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-transfers/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-transfers/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/stock-transfers', {
        body: { ...input, docDate: apiDateTime(input.docDate) } as StockTransferCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/stock-transfers/{id}', {
        params: { path: { id } },
        body: { ...input, docDate: apiDateTime(input.docDate) } as StockTransferUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/stock-transfers/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'ship') {
        await apiData(apiClient.POST('/inventory/stock-transfers/{id}/ship', { params: { path: { id } } }))
      } else if (key === 'receive') {
        await receiveStockTransfer(id, {})
      } else {
        throw new Error(`库存调拨单不支持动作 ${key}`)
      }
    }
  },
}

export const stockTransferItemClient: ResourceClient = {
  id: 'rest:invStockTransferItems',
  meta: () => meta('invStockTransferItems'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-transfer-items/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-transfer-items/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/stock-transfer-items', { body: input as StockTransferItemCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/stock-transfer-items/{id}', {
        params: { path: { id } },
        body: input as StockTransferItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/stock-transfer-items/{id}', { params: { path: { id } } }),
    )
  },
}

export const stockCountClient: ResourceClient = {
  id: 'rest:invStockCounts',
  meta: () => meta('invStockCounts'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-counts/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-counts/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/stock-counts', {
        body: { ...input, postingDate: apiDateTime(input.postingDate) } as StockCountCreate,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/stock-counts/{id}', {
        params: { path: { id } },
        body: { ...input, postingDate: apiDateTime(input.postingDate) } as StockCountUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/stock-counts/{id}', { params: { path: { id } } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'approve') {
        await apiData(apiClient.POST('/inventory/stock-counts/{id}/approve', { params: { path: { id } } }))
      } else if (key === 'cancel') {
        await apiData(apiClient.POST('/inventory/stock-counts/{id}/cancel', { params: { path: { id } } }))
      } else {
        throw new Error(`库存盘点单不支持动作 ${key}`)
      }
    }
  },
}

export const stockCountItemClient: ResourceClient = {
  id: 'rest:invStockCountItems',
  meta: () => meta('invStockCountItems'),
  async query(input) {
    const result = await apiData(
      apiClient.POST('/inventory/stock-count-items/query', { body: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/inventory/stock-count-items/{id}', { params: { path: { id } } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/inventory/stock-count-items', { body: input as StockCountItemCreate }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/inventory/stock-count-items/{id}', {
        params: { path: { id } },
        body: input as StockCountItemUpdate,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/inventory/stock-count-items/{id}', { params: { path: { id } } }),
    )
  },
}

export async function queryStockBalance(input: StockBalanceQuery) {
  return apiData(
    apiClient.POST('/inventory/stock-balance/query', {
      body: { ...input, asOf: apiDateTime(input.asOf) } as StockBalanceQuery,
    }),
  )
}

export async function receiveStockTransfer(id: string, input: StockTransferReceive) {
  return apiData(
    apiClient.POST('/inventory/stock-transfers/{id}/receive', {
      params: { path: { id } },
      body: input,
    }),
  )
}

export async function refreshStockCount(id: string) {
  return apiData(
    apiClient.POST('/inventory/stock-counts/{id}/refresh', {
      params: { path: { id } },
    }),
  )
}

export async function seedWarehouseDefaults(companyId: string) {
  return apiData(
    apiClient.POST('/inventory/warehouses/seed-defaults', {
      body: { companyId },
    }),
  )
}
export async function queryOutsourcedWarehouses(
  partyType: WarehouseOutsourcedQuery['partyType'],
  partyId: string,
) {
  const result = await apiData(
    apiClient.POST('/inventory/warehouses/outsourced/query', {
      body: {
        limit: 100,
        offset: 0,
        sort: { column: 'name', direction: 'ascending' },
        partyType,
        partyId,
      },
    }),
  )
  return result.results as Row[]
}
