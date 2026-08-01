import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import { decimalWireInput, resourceListBody } from './resource-wire'
import type { ResourceTransport } from './types'

type ResourceOperations = Pick<ResourceTransport, 'query' | 'get'> &
  Partial<Pick<ResourceTransport, 'create' | 'update' | 'delete'>>

function resourceClient<const TOperations extends ResourceOperations>(
  resource: string,
  operations: TOperations,
): { id: string } & TOperations {
  return {
    id: `rest:${resource}`,
    ...operations,
  }
}

async function salesAction(
  id: string,
  action: 'confirm' | 'unconfirm' | 'audit' | 'void',
) {
  if (action === 'confirm') {
    return apiData(
      api.sales.reconciliations[':id'].confirm.$post({
        param: { id }}),
    )
  }
  if (action === 'unconfirm') {
    return apiData(
      api.sales.reconciliations[':id'].unconfirm.$post({
        param: { id }}),
    )
  }
  if (action === 'audit') {
    return apiData(
      api.sales.reconciliations[':id'].audit.$post({
        param: { id }}),
    )
  }
  return apiData(
    api.sales.reconciliations[':id'].void.$post({
      param: { id }}),
  )
}

async function purchaseAction(
  id: string,
  action: 'confirm' | 'unconfirm' | 'audit' | 'void',
) {
  if (action === 'confirm') {
    return apiData(
      api.purchase.reconciliations[':id'].confirm.$post({
        param: { id }}),
    )
  }
  if (action === 'unconfirm') {
    return apiData(
      api.purchase.reconciliations[':id'].unconfirm.$post({
        param: { id }}),
    )
  }
  if (action === 'audit') {
    return apiData(
      api.purchase.reconciliations[':id'].audit.$post({
        param: { id }}),
    )
  }
  return apiData(
    api.purchase.reconciliations[':id'].void.$post({
      param: { id }}),
  )
}

export const salesReconciliationCommandAdapter = createRowCommandAdapter({
  confirm: {
    handler: (id) => salesAction(id, 'confirm'),
    affectedResources: ['salReconciliationItems', 'salDeliveryItems'],
  },
  unconfirm: {
    handler: (id) => salesAction(id, 'unconfirm'),
    affectedResources: ['salReconciliationItems', 'salDeliveryItems'],
  },
  audit: {
    handler: (id) => salesAction(id, 'audit'),
    affectedResources: [
      'salReconciliationItems',
      'salDeliveryItems',
      'accGlEntries',
    ],
  },
  void: {
    handler: (id) => salesAction(id, 'void'),
    affectedResources: [
      'salReconciliationItems',
      'salDeliveryItems',
      'accGlEntries',
    ],
  },
})

export const purchaseReconciliationCommandAdapter = createRowCommandAdapter({
  confirm: {
    handler: (id) => purchaseAction(id, 'confirm'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
    ],
  },
  unconfirm: {
    handler: (id) => purchaseAction(id, 'unconfirm'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
    ],
  },
  audit: {
    handler: (id) => purchaseAction(id, 'audit'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
      'accGlEntries',
    ],
  },
  void: {
    handler: (id) => purchaseAction(id, 'void'),
    affectedResources: [
      'purReconciliationItems',
      'purReceiptItems',
      'purOutsourcedReceiptItems',
      'accGlEntries',
    ],
  },
})

export const salesReconciliationClient = resourceClient('salReconciliations', {
  async query(input) {
    const result = await apiData(
      api.sales.reconciliations.query.$post({ json: resourceListBody(input) }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.sales.reconciliations[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.sales.reconciliations.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.sales.reconciliations[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.sales.reconciliations[':id'].$delete({
        param: { id }}),
    )
  },
})

export const salesReconciliationItemClient = resourceClient(
  'salReconciliationItems',
  {
    async query(input) {
      const result = await apiData(
        api.sales['reconciliation-items'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.sales['reconciliation-items'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.sales['reconciliation-items'].$post({
          json: decimalWireInput(input, ['qty']) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.sales['reconciliation-items'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, ['qty']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.sales['reconciliation-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseReconciliationClient = resourceClient(
  'purReconciliations',
  {
    async query(input) {
      const result = await apiData(
        api.purchase.reconciliations.query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase.reconciliations[':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase.reconciliations.$post({ json: input as never }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase.reconciliations[':id'].$patch({
          param: { id },
          json: input as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase.reconciliations[':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const purchaseReconciliationItemClient = resourceClient(
  'purReconciliationItems',
  {
    async query(input) {
      const result = await apiData(
        api.purchase['reconciliation-items'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.purchase['reconciliation-items'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.purchase['reconciliation-items'].$post({
          json: decimalWireInput(input, ['qty']) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['reconciliation-items'][':id'].$patch({
          param: { id },
          json: decimalWireInput(input, ['qty']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData(
        api.purchase['reconciliation-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const companyAccountDefaultClient = resourceClient(
  'salCompanyAccountDefaults',
  {
    async query(input) {
      const result = await apiData(
        api.sales['company-account-defaults'].query.$post({
          json: resourceListBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.sales['company-account-defaults'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.sales['company-account-defaults'].$post({
          json: input as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.sales['company-account-defaults'][':id'].$patch({
          param: { id },
          json: input as never}),
      )) as Row
    },
  },
)

export const orderFlowItemClient = resourceClient('scmOrderFlowItems', {
  async query(input) {
    const result = await apiData(
      api.scm['order-flow-items'].query.$post({
        json: resourceListBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.scm['order-flow-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
})
