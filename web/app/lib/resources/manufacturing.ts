import { apiData, api } from '../api/client'
import { toast } from '@heroui/react'
import { createRowCommandAdapter } from './catalog/commands'
import { restTransport } from './rest-transport'

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

/** 下发/改派车间：仅已确认未关闭的需求单可用；草稿态改车间走表单 */
export async function dispatchDemand(id: string, assignedDeptId: string) {
  return apiData(
    api.manufacturing.demands[':id'].dispatch.$post({
      param: { id },
      json: { assignedDeptId }}),
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
  const result = await apiData(
    api.manufacturing['work-orders'][':id'].void.$post({
      param: { id }}),
  )
  // 作废级联（票 04）：派生草稿已自动删除；已确认派生单只警告不拦截，单号名单由人收场
  if (result.confirmedDerivedDemandNos.length > 0) {
    toast.warning('工单已作废，但存在已确认的派生需求单，请人工收场', {
      description: result.confirmedDerivedDemandNos.join('、'),
    })
  }
  return result
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

/**
 * 「生成物料需求」弹窗取数（票 02）：每配料行的毛需求、参考库存（本公司全仓现货
 * 合计快照，只读不锁不扣）与服务端默认（数量=毛−参考库存下限 0；covered=库存足够
 * 默认去向「不需要」），均折算到行单位；前端不自行聚合库存。
 */
export async function getMaterialDemandPreview(id: string) {
  return apiData(
    api.manufacturing['work-orders'][':id']['material-demand-preview'].$get({
      param: { id },
    }),
  )
}

/**
 * 生成物料需求（工单物料需求派生，票 01）：逐行去向分流，按去向分组单事务生成需求单草稿。
 * 响应含生成草稿清单（id+单号+去向）与服务端算出的每行毛需求回显。
 * 重复生成（票 04）：已有未删除派生草稿时响应带 warning（不生成），二次确认后 force 重发。
 */
export async function generateMaterialDemand(
  id: string,
  lines: Array<{
    componentId: string
    qty: string
    target: { kind: 'dept'; deptId: string } | { kind: 'purchase' }
  }>,
  force?: boolean,
) {
  return apiData(
    api.manufacturing['work-orders'][':id']['generate-material-demand'].$post({
      param: { id },
      json: { lines, force },
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

export const operationClient = restTransport(
  'mfgOperations',
  api.manufacturing.operations,
)

export const moldDesignClient = restTransport(
  'mfgMoldDesigns',
  api.manufacturing['mold-designs'],
)

export const processTemplateClient = restTransport(
  'mfgProcessTemplates',
  api.manufacturing['process-templates'],
)

export const processTemplateItemClient = restTransport(
  'mfgProcessTemplateItems',
  api.manufacturing['process-template-items'],
)

export const bomClient = restTransport('mfgBoms', api.manufacturing.boms)

export const bomComponentClient = restTransport(
  'mfgBomComponents',
  api.manufacturing['bom-components'],
  { decimalFields: ['quantity', 'lossRate'] },
)

export const bomRouteClient = restTransport(
  'mfgBomRoutes',
  api.manufacturing['bom-routes'],
)

export const bomByproductClient = restTransport(
  'mfgBomByproducts',
  api.manufacturing['bom-byproducts'],
  { decimalFields: ['quantity'] },
)

export const demandClient = restTransport('mfgDemands', api.manufacturing.demands)

export const demandItemClient = restTransport(
  'mfgDemandItems',
  api.manufacturing['demand-items'],
  { decimalFields: ['qty'] },
)

export const workOrderClient = restTransport(
  'mfgWorkOrders',
  api.manufacturing['work-orders'],
)

export const outputClient = restTransport('mfgOutputs', api.manufacturing.outputs)

export const outputItemClient = restTransport(
  'mfgOutputItems',
  api.manufacturing['output-items'],
  { decimalFields: ['qty'] },
)
