import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

const pages = [
  './operations.tsx',
  './process-templates.tsx',
  './boms.tsx',
  './demands/-demand-drawer.tsx',
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

  test('basic 工序走 Catalog Form，其余 Grid/Drawer/明细绑定 REST transport', () => {
    const operation = source('./operations.tsx')
    expect(operation).toContain("const RESOURCE = 'mfgOperations'")
    expect(operation).toContain('useCatalogBasicForm(RESOURCE')
    expect(operation.match(/client=\{client\}/g)?.length).toBe(2)

    const template = source('./process-templates.tsx')
    expect(template.match(/client=\{processTemplateClient\}/g)?.length).toBe(2)
    expect(template).toContain('client={processTemplateItemClient}')

    const bom = source('./boms.tsx')
    expect(bom.match(/client=\{bomClient\}/g)?.length).toBe(2)
    expect(bom).toContain('client={bomComponentClient}')
    expect(bom).toContain('client={bomRouteClient}')
    expect(bom).toContain('client={bomByproductClient}')

    const demandOrders = source('./demands/orders.tsx')
    const demandDrawer = source('./demands/-demand-drawer.tsx')
    expect(demandOrders).toContain('client={demandClient}')
    expect(demandDrawer).toContain('client={demandClient}')
    expect(demandDrawer).toContain('client={demandItemClient}')
    expect(source('./demands/items.tsx')).toContain('client={demandItemClient}')
    expect(source('./demands/-item-actions.tsx')).toContain(
      "useGridMeta('mfgDemandItems', true)",
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

  test('新增和编辑履约需求行不暴露系统维护投影', () => {
    const demand = source('./demands/-demand-drawer.tsx')
    const itemExclude = demand.match(
      /<SynieEditableTable[\s\S]*?exclude=\{\[([\s\S]*?)\]\}\s*columns=/,
    )?.[1]
    expect(itemExclude).toBeDefined()
    for (const field of [
      'orderedQty',
      'receivedQty',
      'ordered',
      'remainingOrderableQty',
    ]) {
      expect(itemExclude).toContain(`'${field}'`)
    }
  })

  test('需求行视图可新建整单，整单头行同屏并接入保存并审核', () => {
    const layout = source('./demands.tsx')
    const items = source('./demands/items.tsx')
    const drawer = source('./demands/-demand-drawer.tsx')
    const drawerConfig = source(
      '../../../components/synie-record-drawer/extension-drawer-props.tsx',
    )
    const recordDrawer = source(
      '../../../components/synie-record-drawer/SynieRecordDrawer.tsx',
    )
    const client = source('../../../lib/resources/manufacturing.ts')

    expect(layout).toContain('<DemandDrawerProvider>')
    expect(items).toContain('createLabel="新建需求单"')
    expect(items).toContain("openDrawer('create', null)")
    expect(items).toContain(
      "hasPermission(perms.data, 'mfg.demand:create')",
    )
    expect(drawer).toContain('extraContent=')
    expect(drawer).not.toContain('tabExtraContent=')
    expect(drawer).toContain('defaultValue: todayLocal()')
    expect(
      drawerConfig.match(/mfgDemands:\s*\{[\s\S]*?\n  \},\n  mfgWorkOrders:/)?.[0],
    ).not.toContain('tabs:')
    expect(client).toContain('audit: confirmDemand')
    expect(recordDrawer).toContain('auditAction.requiredCapability')
  })
})
