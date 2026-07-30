import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = FilterState

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
  operations: Omit<ResourceClient, 'id'>,
): ResourceClient {
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

export const salesReconciliationClient = resourceClient('salReconciliations', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.sales.reconciliations.query.$post({ json: queryBody(input) }),
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
    await apiData<void>(
      api.sales.reconciliations[':id'].$delete({
        param: { id }}),
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.sales['reconciliation-items'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, ['qty']) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.sales['reconciliation-items'][':id'].$patch({
          param: { id },
          json: decimalInput(input, ['qty']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase.reconciliations.query.$post({
          json: queryBody(input)}),
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
      await apiData<void>(
        api.purchase.reconciliations[':id'].$delete({
          param: { id }}),
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.purchase['reconciliation-items'].query.$post({
          json: queryBody(input)}),
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
          json: decimalInput(input, ['qty']) as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.purchase['reconciliation-items'][':id'].$patch({
          param: { id },
          json: decimalInput(input, ['qty']) as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
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
      const result = await apiData<{ count: number; results: Row[] }>(
        api.sales['company-account-defaults'].query.$post({
          json: queryBody(input)}),
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
    async delete() {
      throw new Error('公司默认过账科目不支持删除；清配置请将四个科目槽更新为空')
    },
  },
)

export const orderFlowItemClient = resourceClient('scmOrderFlowItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.scm['order-flow-items'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.scm['order-flow-items'][':id'].$get({
        param: { id }}),
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
