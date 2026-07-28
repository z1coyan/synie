import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'
import { gridMeta } from './meta'

type MaterialCategoryCreate = Record<string, unknown>
type MaterialCategoryUpdate = Record<string, unknown>
type MaterialCreate = Record<string, unknown>
type MaterialUpdate = Record<string, unknown>
type MaterialUnitCreate = Record<string, unknown>
type MaterialUnitUpdate = Record<string, unknown>
type WarehouseCreate = Record<string, unknown>
type WarehouseUpdate = Record<string, unknown>
type WarehouseOutsourcedQuery = Record<string, unknown>
type StockDocCreate = Record<string, unknown>
type StockDocUpdate = Record<string, unknown>
type StockDocItemCreate = Record<string, unknown>
type StockDocItemUpdate = Record<string, unknown>
type StockTransferCreate = Record<string, unknown>
type StockTransferUpdate = Record<string, unknown>
type StockTransferItemCreate = Record<string, unknown>
type StockTransferItemUpdate = Record<string, unknown>
type StockTransferReceive = Record<string, unknown>
type StockCountCreate = Record<string, unknown>
type StockCountUpdate = Record<string, unknown>
type StockCountItemCreate = Record<string, unknown>
type StockCountItemUpdate = Record<string, unknown>
type StockBalanceQuery = Record<string, unknown>

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
    filter: queryFilter(input) as FilterState,
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
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
        param: { name: resource }}),
    ),
  )
}

export const materialCategoryClient: ResourceClient = {
  id: 'rest:invMaterialCategories',
  meta: () => meta('invMaterialCategories'),
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['material-categories'].query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as FilterState} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['material-categories'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['material-categories'].$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['material-categories'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['material-categories'][':id'].$delete({ param: { id } }),
    )
  },
}

export const materialClient: ResourceClient = {
  id: 'rest:invMaterials',
  meta: () => meta('invMaterials'),
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory.materials.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as FilterState} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory.materials[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory.materials.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory.materials[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory.materials[':id'].$delete({ param: { id } }),
    )
  },
}

export const materialUnitClient: ResourceClient = {
  id: 'rest:invMaterialUnits',
  meta: () => meta('invMaterialUnits'),
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['material-units'].query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as FilterState} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['material-units'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['material-units'].$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['material-units'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['material-units'][':id'].$delete({ param: { id } }),
    )
  },
}

export const warehouseClient: ResourceClient = {
  id: 'rest:invWarehouses',
  meta: () => meta('invWarehouses'),
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory.warehouses.query.$post({
        json: {
          limit: input.limit,
          offset: input.offset,
          search: input.search || undefined,
          sort: input.sort ?? undefined,
          filter: queryFilter(input) as FilterState} }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory.warehouses[':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory.warehouses.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory.warehouses[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory.warehouses[':id'].$delete({ param: { id } }),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-entries'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-entries'][':id'].$get({ param: { id } }),
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-docs'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-docs'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['stock-docs'].$post({
        json: { ...input, docDate: apiDateTime(input.docDate) } as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-docs'][':id'].$patch({
        param: { id },
        json: { ...input, docDate: apiDateTime(input.docDate) } as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['stock-docs'][':id'].$delete({ param: { id } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') {
        await apiData(api.inventory['stock-docs'][':id'].audit.$post({ param: { id } }))
      } else if (key === 'void') {
        await apiData(api.inventory['stock-docs'][':id'].void.$post({ param: { id } }))
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-doc-items'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-doc-items'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['stock-doc-items'].$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-doc-items'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['stock-doc-items'][':id'].$delete({ param: { id } }),
    )
  },
}

export const stockTransferClient: ResourceClient = {
  id: 'rest:invStockTransfers',
  meta: () => meta('invStockTransfers'),
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-transfers'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-transfers'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['stock-transfers'].$post({
        json: { ...input, docDate: apiDateTime(input.docDate) } as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-transfers'][':id'].$patch({
        param: { id },
        json: { ...input, docDate: apiDateTime(input.docDate) } as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['stock-transfers'][':id'].$delete({ param: { id } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'ship') {
        await apiData(api.inventory['stock-transfers'][':id'].ship.$post({ param: { id } }))
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-transfer-items'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-transfer-items'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['stock-transfer-items'].$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-transfer-items'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['stock-transfer-items'][':id'].$delete({ param: { id } }),
    )
  },
}

export const stockCountClient: ResourceClient = {
  id: 'rest:invStockCounts',
  meta: () => meta('invStockCounts'),
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-counts'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-counts'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['stock-counts'].$post({
        json: { ...input, postingDate: apiDateTime(input.postingDate) } as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-counts'][':id'].$patch({
        param: { id },
        json: { ...input, postingDate: apiDateTime(input.postingDate) } as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['stock-counts'][':id'].$delete({ param: { id } }),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'approve') {
        await apiData(api.inventory['stock-counts'][':id'].approve.$post({ param: { id } }))
      } else if (key === 'cancel') {
        await apiData(api.inventory['stock-counts'][':id'].cancel.$post({ param: { id } }))
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
    const result = await apiData<{ count: number; results: Row[] }>(
      api.inventory['stock-count-items'].query.$post({ json: listBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-count-items'][':id'].$get({ param: { id } }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.inventory['stock-count-items'].$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-count-items'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.inventory['stock-count-items'][':id'].$delete({ param: { id } }),
    )
  },
}

export async function queryStockBalance(input: StockBalanceQuery) {
  return apiData<{ results: Array<Row & Record<string, unknown>>; count: number }>(
    api.inventory['stock-balance'].query.$post({
      json: { ...input, asOf: apiDateTime(input.asOf) } as never,
    }),
  )
}

export async function receiveStockTransfer(id: string, input: StockTransferReceive) {
  return apiData(
    api.inventory['stock-transfers'][':id'].receive.$post({
      param: { id },
      json: input as never}),
  )
}

export async function refreshStockCount(id: string) {
  return apiData(
    api.inventory['stock-counts'][':id'].refresh.$post({
      param: { id }}),
  )
}

export async function seedWarehouseDefaults(companyId: string) {
  return apiData(
    api.inventory.warehouses['seed-defaults'].$post({
      json: { companyId }}),
  )
}
export async function queryOutsourcedWarehouses(
  partyType: WarehouseOutsourcedQuery['partyType'],
  partyId: string,
) {
  const result = await apiData<{ count: number; results: Row[] }>(
    api.inventory.warehouses.outsourced.query.$post({
      json: {
        limit: 100,
        offset: 0,
        sort: { column: 'name', direction: 'ascending' },
        partyType,
        partyId} as never }),
  )
  return result.results as Row[]
}
