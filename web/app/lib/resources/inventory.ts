import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import {
  createCommandAdapter,
  createRowCommandAdapter,
  decodeRowTarget,
  defineCommand,
} from './catalog/commands'
import { restTransport } from './rest-transport'
import { dateTimeWireInput } from './resource-wire'

type WarehouseOutsourcedQuery = Record<string, unknown>
type StockTransferReceive = Record<string, unknown>
type StockBalanceQuery = Record<string, unknown>

export const materialCategoryClient = restTransport(
  'invMaterialCategories',
  api.base['material-categories'],
)

export const materialClient = restTransport('invMaterials', api.base.materials)

export const materialUnitClient = restTransport(
  'invMaterialUnits',
  api.base['material-units'],
)

export const warehouseClient = restTransport(
  'invWarehouses',
  api.base.warehouses,
)

export const stockEntryClient = restTransport(
  'invStockEntries',
  api.inventory['stock-entries'],
  { capabilities: { create: false, update: false, delete: false } },
)

export const stockDocClient = restTransport(
  'invStockDocs',
  api.inventory['stock-docs'])

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

export const stockDocItemClient = restTransport(
  'invStockDocItems',
  api.inventory['stock-doc-items'],
)

export const stockTransferClient = restTransport(
  'invStockTransfers',
  api.inventory['stock-transfers'])

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

export const stockTransferItemClient = restTransport(
  'invStockTransferItems',
  api.inventory['stock-transfer-items'],
)

export const stockCountClient = restTransport(
  'invStockCounts',
  api.inventory['stock-counts'])

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

export const stockCountItemClient = restTransport(
  'invStockCountItems',
  api.inventory['stock-count-items'],
)

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
    api.base.warehouses['seed-defaults'].$post({
      json: { companyId }}),
  )
}
export async function queryOutsourcedWarehouses(
  partyType: WarehouseOutsourcedQuery['partyType'],
  partyId: string,
) {
  const result = await apiData(
    api.base.warehouses.outsourced.query.$post({
      json: {
        limit: 100,
        offset: 0,
        sort: { column: 'name', direction: 'ascending' },
        partyType,
        partyId} as never }),
  )
  return result.results as Row[]
}
