import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const pages = [
  './operations.tsx',
  './process-templates.tsx',
  './boms.tsx',
  './demands/orders.tsx',
  './demands/items.tsx',
  './demands/-item-actions.tsx',
  './demands/-sales-item-picker.tsx',
  './work-orders.tsx',
  './outputs.tsx',
] as const

describe('PR-2.17 制造域 REST 边界', () => {
  test('制造消费面不再包含 GraphQL 请求或 operation', () => {
    for (const page of pages) {
      const text = source(page)
      expect(text).not.toContain('gqlFetch')
      expect(text).not.toMatch(/\b(query|mutation)\s+\(\$/)
    }
  })

  test('十二资源均注册 REST client', () => {
    const registry = source('../../../lib/resources/registry.ts')
    for (const resource of [
      'mfgOperations',
      'mfgProcessTemplates',
      'mfgProcessTemplateItems',
      'mfgBoms',
      'mfgBomComponents',
      'mfgBomRoutes',
      'mfgBomByproducts',
      'mfgDemands',
      'mfgDemandItems',
      'mfgWorkOrders',
      'mfgOutputs',
      'mfgOutputItems',
    ]) {
      expect(registry).toContain(`${resource}:`)
    }
  })

  test('Grid、Drawer 与明细表显式绑定制造 REST client', () => {
    const operation = source('./operations.tsx')
    expect(operation.match(/client=\{operationClient\}/g)?.length).toBe(2)

    const template = source('./process-templates.tsx')
    expect(template.match(/client=\{processTemplateClient\}/g)?.length).toBe(2)
    expect(template).toContain('client={processTemplateItemClient}')

    const bom = source('./boms.tsx')
    expect(bom.match(/client=\{bomClient\}/g)?.length).toBe(2)
    expect(bom).toContain('client={bomComponentClient}')
    expect(bom).toContain('client={bomRouteClient}')
    expect(bom).toContain('client={bomByproductClient}')

    const demand = source('./demands/orders.tsx')
    expect(demand.match(/client=\{demandClient\}/g)?.length).toBe(2)
    expect(demand).toContain('client={demandItemClient}')
    expect(source('./demands/items.tsx')).toContain('client={demandItemClient}')
    expect(source('./demands/-item-actions.tsx')).toContain(
      "useGridMeta('mfgDemandItems', true, demandItemClient)",
    )

    const workOrder = source('./work-orders.tsx')
    expect(workOrder.match(/client=\{workOrderClient\}/g)?.length).toBe(2)

    const output = source('./outputs.tsx')
    expect(output.match(/client=\{outputClient\}/g)?.length).toBe(2)
    expect(output).toContain('client={outputItemClient}')
  })

  test('制造动作与子行 diff 全部经 REST client', () => {
    const client = source('../../../lib/resources/manufacturing.ts')
    for (const action of [
      'applyRouteTemplate',
      'confirmDemand',
      'closeDemand',
      'voidDemand',
      'completeDemandItem',
      'changeDemandItemFulfillment',
      'voidWorkOrder',
      'auditOutput',
      'voidOutput',
    ]) {
      expect(client).toContain(`function ${action}`)
    }
    for (const resource of [
      'mfgProcessTemplateItems',
      'mfgBomComponents',
      'mfgBomRoutes',
      'mfgBomByproducts',
      'mfgDemandItems',
      'mfgOutputItems',
    ]) {
      expect(client).toMatch(new RegExp(`resourceClient\\(\\s*'${resource}'`))
    }
  })
})
