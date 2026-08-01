import { apiData, api } from '../api/client'
import type { Row } from '~/components/synie-data-grid/types'
import { createRowCommandAdapter } from './catalog/commands'
import {
  decimalWireInput,
  resourceListBody,
} from './resource-wire'
import type { ResourceClient } from './types'

function resourceClient(
  resource: string,
  operations: Omit<ResourceClient, 'id'>,
): ResourceClient {
  return {
    id: `rest:${resource}`,
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

export async function activateBom(id: string) {
  return apiData(
    api.manufacturing.boms[':id'].activate.$post({
      param: { id },
    }),
  )
}

export async function deactivateBom(id: string) {
  return apiData(
    api.manufacturing.boms[':id'].deactivate.$post({
      param: { id },
    }),
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

export async function applyWorkOrderBom(id: string, bomId: string | null) {
  return apiData(
    api.manufacturing['work-orders'][':id']['apply-bom'].$post({
      param: { id },
      json: { bomId },
    }),
  )
}

export async function getWorkOrderBomSnapshot(id: string) {
  return apiData(
    api.manufacturing['work-orders'][':id']['bom-snapshot'].$get({
      param: { id },
    }),
  )
}

/** 工单内嵌创建 BOM（启用并立即选入快照）；需 mfg.bom:create */
export async function createWorkOrderInlineBom(
  id: string,
  input: {
    code?: string | null
    planName?: string | null
    note?: string | null
    components?: Array<{
      materialId: string
      unitId: string
      quantity: string
      lossRate?: string | null
      note?: string | null
    }>
    routes?: Array<{
      operationId: string
      seq: number
      requirement?: string | null
      isOutsourced?: boolean
    }>
    byproducts?: Array<{
      materialId: string
      unitId: string
      quantity: string
      note?: string | null
    }>
  },
) {
  return apiData(
    api.manufacturing['work-orders'][':id']['create-bom'].$post({
      param: { id },
      json: input as never,
    }),
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

export const demandCommandAdapter = createRowCommandAdapter({
  audit: confirmDemand,
  close: closeDemand,
  void: voidDemand,
})

export const workOrderCommandAdapter = createRowCommandAdapter({
  void: {
    handler: voidWorkOrder,
    affectedResources: ['mfgDemandItems', 'mfgDemands'],
  },
})

export const outputCommandAdapter = createRowCommandAdapter({
  audit: {
    handler: auditOutput,
    affectedResources: [
      'mfgOutputItems',
      'mfgWorkOrders',
      'mfgDemandItems',
      'mfgDemands',
      'invStockEntries',
    ],
  },
  void: {
    handler: voidOutput,
    affectedResources: [
      'mfgOutputItems',
      'mfgWorkOrders',
      'mfgDemandItems',
      'mfgDemands',
      'invStockEntries',
    ],
  },
})

export const bomCommandAdapter = createRowCommandAdapter({
  activate: activateBom,
  deactivate: deactivateBom,
})

export const operationClient = resourceClient('mfgOperations', {
  async query(input) {
    const result = await apiData(
      api.manufacturing.operations.query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing.operations[':id'].$delete({
        param: { id }}),
    )
  },
})

export const processTemplateClient = resourceClient('mfgProcessTemplates', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['process-templates'].query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing['process-templates'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const processTemplateItemClient = resourceClient(
  'mfgProcessTemplateItems',
  {
    async query(input) {
      const result = await apiData(
        api.manufacturing['process-template-items'].query.$post({
          json: resourceListBody(input)}),
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
      await apiData(
        api.manufacturing['process-template-items'][':id'].$delete({
          param: { id }}),
      )
    },
  },
)

export const bomClient = resourceClient('mfgBoms', {
  async query(input) {
    const result = await apiData(
      api.manufacturing.boms.query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing.boms[':id'].$delete({
        param: { id }}),
    )
  },
})

export const bomComponentClient = resourceClient('mfgBomComponents', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['bom-components'].query.$post({
        json: resourceListBody(input)}),
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
        json: decimalWireInput(input, ['quantity', 'lossRate']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['bom-components'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['quantity', 'lossRate']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.manufacturing['bom-components'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bomRouteClient = resourceClient('mfgBomRoutes', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['bom-routes'].query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing['bom-routes'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const bomByproductClient = resourceClient('mfgBomByproducts', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['bom-byproducts'].query.$post({
        json: resourceListBody(input)}),
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
        json: decimalWireInput(input, ['quantity']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['bom-byproducts'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['quantity']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.manufacturing['bom-byproducts'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const demandClient = resourceClient('mfgDemands', {
  async query(input) {
    const result = await apiData(
      api.manufacturing.demands.query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing.demands[':id'].$delete({
        param: { id }}),
    )
  },
})

export const demandItemClient = resourceClient('mfgDemandItems', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['demand-items'].query.$post({
        json: resourceListBody(input)}),
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
        json: decimalWireInput(input, ['qty']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['demand-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['qty']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.manufacturing['demand-items'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const workOrderClient = resourceClient('mfgWorkOrders', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['work-orders'].query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing['work-orders'][':id'].$delete({
        param: { id }}),
    )
  },
})

export const outputClient = resourceClient('mfgOutputs', {
  async query(input) {
    const result = await apiData(
      api.manufacturing.outputs.query.$post({
        json: resourceListBody(input)}),
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
    await apiData(
      api.manufacturing.outputs[':id'].$delete({
        param: { id }}),
    )
  },
})

export const outputItemClient = resourceClient('mfgOutputItems', {
  async query(input) {
    const result = await apiData(
      api.manufacturing['output-items'].query.$post({
        json: resourceListBody(input)}),
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
        json: decimalWireInput(input, ['qty']) as never}),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      api.manufacturing['output-items'][':id'].$patch({
        param: { id },
        json: decimalWireInput(input, ['qty']) as never}),
    )) as Row
  },
  async delete(id) {
    await apiData(
      api.manufacturing['output-items'][':id'].$delete({
        param: { id }}),
    )
  },
})
