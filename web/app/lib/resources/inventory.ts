import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  createRowCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import {
  dateTimeWireInput,
  resourceListBody,
} from './resource-wire'
import type { ResourceClient, ResourceTransport } from './types'

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

export const materialCategoryClient: ResourceClient = {
  id: 'rest:invMaterialCategories',
  async query(input) {
    const result = await apiData(
      api.inventory['material-categories'].query.$post({
        json: resourceListBody(input),
      }),
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
    await apiData(
      api.inventory['material-categories'][':id'].$delete({ param: { id } }),
    )
  },
}

export const materialClient: ResourceClient = {
  id: 'rest:invMaterials',
  async query(input) {
    const result = await apiData(
      api.inventory.materials.query.$post({
        json: resourceListBody(input),
      }),
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
    await apiData(
      api.inventory.materials[':id'].$delete({ param: { id } }),
    )
  },
}

export const materialUnitClient: ResourceClient = {
  id: 'rest:invMaterialUnits',
  async query(input) {
    const result = await apiData(
      api.inventory['material-units'].query.$post({
        json: resourceListBody(input),
      }),
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
    await apiData(
      api.inventory['material-units'][':id'].$delete({ param: { id } }),
    )
  },
}

export const warehouseClient: ResourceClient = {
  id: 'rest:invWarehouses',
  async query(input) {
    const result = await apiData(
      api.inventory.warehouses.query.$post({
        json: resourceListBody(input),
      }),
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
    await apiData(
      api.inventory.warehouses[':id'].$delete({ param: { id } }),
    )
  },
}

export const stockEntryClient: ResourceTransport = {
  id: 'rest:invStockEntries',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-entries'].query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.inventory['stock-entries'][':id'].$get({ param: { id } }),
    )) as Row
  },
}

export const stockDocClient: ResourceClient = {
  id: 'rest:invStockDocs',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-docs'].query.$post({ json: resourceListBody(input) }),
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
        json: dateTimeWireInput(input, ['docDate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-docs'][':id'].$patch({
        param: { id },
        json: dateTimeWireInput(input, ['docDate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.inventory['stock-docs'][':id'].$delete({ param: { id } }),
    )
  },
}

async function auditStockDoc(id: string) {
  return apiData(api.inventory['stock-docs'][':id'].audit.$post({ param: { id } }))
}

async function voidStockDoc(id: string) {
  return apiData(api.inventory['stock-docs'][':id'].void.$post({ param: { id } }))
}

export const stockDocCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditStockDoc,
    affectedResources: ['invStockEntries'],
  },
  void: {
    handler: voidStockDoc,
    affectedResources: ['invStockEntries'],
  },
})

export const stockDocItemClient: ResourceClient = {
  id: 'rest:invStockDocItems',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-doc-items'].query.$post({ json: resourceListBody(input) }),
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
    await apiData(
      api.inventory['stock-doc-items'][':id'].$delete({ param: { id } }),
    )
  },
}

export const stockTransferClient: ResourceClient = {
  id: 'rest:invStockTransfers',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-transfers'].query.$post({ json: resourceListBody(input) }),
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
        json: dateTimeWireInput(input, ['docDate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-transfers'][':id'].$patch({
        param: { id },
        json: dateTimeWireInput(input, ['docDate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.inventory['stock-transfers'][':id'].$delete({ param: { id } }),
    )
  },
}

async function shipStockTransfer(id: string) {
  return apiData(api.inventory['stock-transfers'][':id'].ship.$post({ param: { id } }))
}

export const stockTransferCommandAdapter = createCommandAdapter({
  ship: defineCommand(
    'row',
    async (input: unknown) => shipStockTransfer(decodeRowTarget(input)),
    { affectedResources: ['invStockEntries'] },
  ),
  receive: defineCommand(
    'row',
    async (input: unknown) => {
      const id = decodeRowTarget(input)
      const { id: _id, ...payload } = input as Record<string, unknown>
      return receiveStockTransfer(id, payload)
    },
    {
      affectedResources: ['invStockTransferItems', 'invStockEntries'],
    },
  ),
})

export const stockTransferItemClient: ResourceClient = {
  id: 'rest:invStockTransferItems',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-transfer-items'].query.$post({ json: resourceListBody(input) }),
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
    await apiData(
      api.inventory['stock-transfer-items'][':id'].$delete({ param: { id } }),
    )
  },
}

export const stockCountClient: ResourceClient = {
  id: 'rest:invStockCounts',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-counts'].query.$post({ json: resourceListBody(input) }),
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
        json: dateTimeWireInput(input, ['postingDate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.inventory['stock-counts'][':id'].$patch({
        param: { id },
        json: dateTimeWireInput(input, ['postingDate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.inventory['stock-counts'][':id'].$delete({ param: { id } }),
    )
  },
}

async function approveStockCount(id: string) {
  return apiData(api.inventory['stock-counts'][':id'].approve.$post({ param: { id } }))
}

async function cancelStockCount(id: string) {
  return apiData(api.inventory['stock-counts'][':id'].cancel.$post({ param: { id } }))
}

export const stockCountCommandAdapter = createRowCommandAdapter({
  approve: {
    handler: approveStockCount,
    affectedResources: ['invStockEntries'],
  },
  cancel: {
    handler: cancelStockCount,
    affectedResources: ['invStockEntries'],
  },
})

export const stockCountItemClient: ResourceClient = {
  id: 'rest:invStockCountItems',
  async query(input) {
    const result = await apiData(
      api.inventory['stock-count-items'].query.$post({ json: resourceListBody(input) }),
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
    await apiData(
      api.inventory['stock-count-items'][':id'].$delete({ param: { id } }),
    )
  },
}

export async function queryStockBalance(input: StockBalanceQuery) {
  return apiData(
    api.inventory['stock-balance'].query.$post({
      json: dateTimeWireInput(input, ['asOf']) as never,
    }),
  )
}

async function receiveStockTransfer(id: string, input: StockTransferReceive) {
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
  const result = await apiData(
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
