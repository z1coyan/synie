import { apiData, api } from '../api/client'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = FilterState

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
      await apiData<import("@synie/shared").ResourceMetaDocument>(
        api.meta.resources[':name'].$get({
        param: { name: resource }}),
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

export async function applyRouteTemplate(id: string, templateId: string) {
  return apiData(
    api.manufacturing.boms[':id']['apply-route-template'].$post({
      param: { id },
      json: { templateId }}),
  )
}

export async function confirmDemand(id: string) {
  return apiData(
    api.manufacturing.demands[':id'].confirm.$post({
      param: { id }}),
  )
}

export async function closeDemand(id: string) {
  return apiData(
    api.manufacturing.demands[':id'].close.$post({
      param: { id }}),
  )
}

export async function voidDemand(id: string) {
  return apiData(
    api.manufacturing.demands[':id'].void.$post({
      param: { id }}),
  )
}

export async function completeDemandItem(id: string) {
  return apiData(
    api.manufacturing['demand-items'][':id'].complete.$post({
      param: { id }}),
  )
}

export async function changeDemandItemFulfillment(
  id: string,
  fulfillmentMethod: string,
) {
  return apiData(
    api.manufacturing['demand-items'][':id'].fulfillment.$post({
      param: { id },
      json: { fulfillmentMethod } as never}),
  )
}

export async function voidWorkOrder(id: string) {
  return apiData(
    api.manufacturing['work-orders'][':id'].void.$post({
      param: { id }}),
  )
}

export async function auditOutput(id: string) {
  return apiData(
    api.manufacturing.outputs[':id'].audit.$post({
      param: { id }}),
  )
}

export async function voidOutput(id: string) {
  return apiData(
    api.manufacturing.outputs[':id'].void.$post({
      param: { id }}),
  )
}

export const operationClient = resourceClient('mfgOperations', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing.operations.query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing.operations[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing.operations.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing.operations[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing.operations[':id'].$delete({
        param: { id }}),
    )
  },
})

export const processTemplateClient = resourceClient('mfgProcessTemplates', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['process-templates'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['process-templates'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['process-templates'].$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['process-templates'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['process-templates'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const processTemplateItemClient = resourceClient(
  'mfgProcessTemplateItems',
  {
    async query(input) {
      const result = await apiData<{ count: number; results: Row[] }>(
        api.manufacturing['process-template-items'].query.$post({
          json: queryBody(input)}),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        api.manufacturing['process-template-items'][':id'].$get({
          param: { id }}),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        api.manufacturing['process-template-items'].$post({
          json: input as never}),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        api.manufacturing['process-template-items'][':id'].$patch({
          param: { id },
          json: input as never}),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        api.manufacturing['process-template-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const bomClient = resourceClient('mfgBoms', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing.boms.query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing.boms[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing.boms.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing.boms[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing.boms[':id'].$delete({
        param: { id }}),
    )
  },
})

export const bomComponentClient = resourceClient('mfgBomComponents', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['bom-components'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['bom-components'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['bom-components'].$post({
        json: decimalInput(input, ['quantity', 'lossRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['bom-components'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['quantity', 'lossRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['bom-components'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bomRouteClient = resourceClient('mfgBomRoutes', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['bom-routes'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['bom-routes'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['bom-routes'].$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['bom-routes'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['bom-routes'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bomByproductClient = resourceClient('mfgBomByproducts', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['bom-byproducts'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['bom-byproducts'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['bom-byproducts'].$post({
        json: decimalInput(input, ['quantity']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['bom-byproducts'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['quantity']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['bom-byproducts'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const demandClient = resourceClient('mfgDemands', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing.demands.query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing.demands[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing.demands.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing.demands[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing.demands[':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'confirm') await confirmDemand(id)
      else if (key === 'close') await closeDemand(id)
      else if (key === 'void') await voidDemand(id)
      else throw new Error(`履约需求单 REST Client 未实现动作 ${key}`)
    }
  },
})

export const demandItemClient = resourceClient('mfgDemandItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['demand-items'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['demand-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['demand-items'].$post({
        json: decimalInput(input, ['qty']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['demand-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['qty']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['demand-items'][':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    if (key !== 'complete') {
      throw new Error(`履约需求行 REST Client 未实现动作 ${key}`)
    }
    for (const id of ids) await completeDemandItem(id)
  },
})

export const workOrderClient = resourceClient('mfgWorkOrders', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['work-orders'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['work-orders'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['work-orders'].$post({
        json: input as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['work-orders'][':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['work-orders'][':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    if (key !== 'void') {
      throw new Error(`生产工单 REST Client 未实现动作 ${key}`)
    }
    for (const id of ids) await voidWorkOrder(id)
  },
})

export const outputClient = resourceClient('mfgOutputs', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing.outputs.query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing.outputs[':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing.outputs.$post({ json: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing.outputs[':id'].$patch({
        param: { id },
        json: input as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing.outputs[':id'].$delete({
        param: { id }}),
    )
  },
  async action(key, ids) {
    for (const id of ids) {
      if (key === 'audit') await auditOutput(id)
      else if (key === 'void') await voidOutput(id)
      else throw new Error(`生产入库单 REST Client 未实现动作 ${key}`)
    }
  },
})

export const outputItemClient = resourceClient('mfgOutputItems', {
  async query(input) {
    const result = await apiData<{ count: number; results: Row[] }>(
      api.manufacturing['output-items'].query.$post({
        json: queryBody(input)}),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      api.manufacturing['output-items'][':id'].$get({
        param: { id }}),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      api.manufacturing['output-items'].$post({
        json: decimalInput(input, ['qty']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['output-items'][':id'].$patch({
        param: { id },
        json: decimalInput(input, ['qty']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      api.manufacturing['output-items'][':id'].$delete({
        param: { id }}),
    )
  },
})
