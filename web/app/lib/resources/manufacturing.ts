import { apiClient, apiData } from '../api/client'
import type { components } from '../api/schema'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { gridMeta } from './meta'
import type { ResourceClient, ResourceQuery } from './types'

type FilterDocument = components['schemas']['FilterState']

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

export async function applyRouteTemplate(id: string, templateId: string) {
  return apiData(
    apiClient.POST('/manufacturing/boms/{id}/apply-route-template', {
      params: { path: { id } },
      body: { templateId },
    }),
  )
}

export async function confirmDemand(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/demands/{id}/confirm', {
      params: { path: { id } },
    }),
  )
}

export async function closeDemand(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/demands/{id}/close', {
      params: { path: { id } },
    }),
  )
}

export async function voidDemand(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/demands/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export async function completeDemandItem(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/demand-items/{id}/complete', {
      params: { path: { id } },
    }),
  )
}

export async function changeDemandItemFulfillment(
  id: string,
  fulfillmentMethod: string,
) {
  return apiData(
    apiClient.POST('/manufacturing/demand-items/{id}/fulfillment', {
      params: { path: { id } },
      body: { fulfillmentMethod } as never,
    }),
  )
}

export async function voidWorkOrder(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/work-orders/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export async function auditOutput(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/outputs/{id}/audit', {
      params: { path: { id } },
    }),
  )
}

export async function voidOutput(id: string) {
  return apiData(
    apiClient.POST('/manufacturing/outputs/{id}/void', {
      params: { path: { id } },
    }),
  )
}

export const operationClient = resourceClient('mfgOperations', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/operations/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/operations/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/operations', { body: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/operations/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/operations/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const processTemplateClient = resourceClient('mfgProcessTemplates', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/process-templates/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/process-templates/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/process-templates', {
        body: input as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/process-templates/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/process-templates/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const processTemplateItemClient = resourceClient(
  'mfgProcessTemplateItems',
  {
    async query(input) {
      const result = await apiData(
        apiClient.POST('/manufacturing/process-template-items/query', {
          body: queryBody(input),
        }),
      )
      return { count: result.count, results: result.results as Row[] }
    },
    async get(id) {
      return (await apiData(
        apiClient.GET('/manufacturing/process-template-items/{id}', {
          params: { path: { id } },
        }),
      )) as Row
    },
    async create(input) {
      return (await apiData(
        apiClient.POST('/manufacturing/process-template-items', {
          body: input as never,
        }),
      )) as Row
    },
    async update(id, input) {
      return (await apiData(
        apiClient.PATCH('/manufacturing/process-template-items/{id}', {
          params: { path: { id } },
          body: input as never,
        }),
      )) as Row
    },
    async delete(id) {
      await apiData<void>(
        apiClient.DELETE('/manufacturing/process-template-items/{id}', {
          params: { path: { id } },
        }),
      )
    },
  },
)

export const bomClient = resourceClient('mfgBoms', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/boms/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/boms/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/boms', { body: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/boms/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/boms/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const bomComponentClient = resourceClient('mfgBomComponents', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/bom-components/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/bom-components/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/bom-components', {
        body: decimalInput(input, ['quantity', 'lossRate']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/bom-components/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['quantity', 'lossRate']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/bom-components/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const bomRouteClient = resourceClient('mfgBomRoutes', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/bom-routes/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/bom-routes/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/bom-routes', {
        body: input as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/bom-routes/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/bom-routes/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const bomByproductClient = resourceClient('mfgBomByproducts', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/bom-byproducts/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/bom-byproducts/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/bom-byproducts', {
        body: decimalInput(input, ['quantity']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/bom-byproducts/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['quantity']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/bom-byproducts/{id}', {
        params: { path: { id } },
      }),
    )
  },
})

export const demandClient = resourceClient('mfgDemands', {
  async query(input) {
    const result = await apiData(
      apiClient.POST('/manufacturing/demands/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/demands/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/demands', { body: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/demands/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/demands/{id}', {
        params: { path: { id } },
      }),
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
    const result = await apiData(
      apiClient.POST('/manufacturing/demand-items/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/demand-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/demand-items', {
        body: decimalInput(input, ['qty']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/demand-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['qty']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/demand-items/{id}', {
        params: { path: { id } },
      }),
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
    const result = await apiData(
      apiClient.POST('/manufacturing/work-orders/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/work-orders/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/work-orders', {
        body: input as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/work-orders/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/work-orders/{id}', {
        params: { path: { id } },
      }),
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
    const result = await apiData(
      apiClient.POST('/manufacturing/outputs/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/outputs/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/outputs', { body: input as never }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/outputs/{id}', {
        params: { path: { id } },
        body: input as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/outputs/{id}', {
        params: { path: { id } },
      }),
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
    const result = await apiData(
      apiClient.POST('/manufacturing/output-items/query', {
        body: queryBody(input),
      }),
    )
    return { count: result.count, results: result.results as Row[] }
  },
  async get(id) {
    return (await apiData(
      apiClient.GET('/manufacturing/output-items/{id}', {
        params: { path: { id } },
      }),
    )) as Row
  },
  async create(input) {
    return (await apiData(
      apiClient.POST('/manufacturing/output-items', {
        body: decimalInput(input, ['qty']) as never,
      }),
    )) as Row
  },
  async update(id, input) {
    return (await apiData(
      apiClient.PATCH('/manufacturing/output-items/{id}', {
        params: { path: { id } },
        body: decimalInput(input, ['qty']) as never,
      }),
    )) as Row
  },
  async delete(id) {
    await apiData<void>(
      apiClient.DELETE('/manufacturing/output-items/{id}', {
        params: { path: { id } },
      }),
    )
  },
})
