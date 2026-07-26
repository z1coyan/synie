import { useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { demandItemClient } from '~/lib/resources/manufacturing'
import {
  canChangeFulfillmentItem,
  canCompleteItem,
  canGenerateWorkOrder,
  useDemandItemActions,
  useMyPermissions,
} from './-item-actions'

export const Route = createFileRoute('/_app/mfg/demands/items')({
  component: DemandItemsTab,
})

/**
 * 需求行行视图(US 17 日常跟单):跨单混排,列筛选即 待安排/已完成(status 枚举)、
 * 按履约方式、按公司(fk 筛选器,SynieDataGrid 内建);行操作挂 完成/改履约方式/生成工单。
 * 来源跳转(US 58):demandId/salesOrderItemId 是 fk 列,有目标资源读权限时渲染 FkLink
 * 点开速览抽屉;无销售读权限时后端 GridMeta 裁剪 ref,列退化为纯文本(fail-closed,零接线)。
 */

// 快照列展示物料/单位(防主数据改名影响历史行);fk 列走 join 标签
const GRID_COLUMNS = [
  'demandId',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  'qty',
  'baseQty',
  'orderedQty',
  'receivedQty',
  'ordered',
  'needDate',
  'fulfillmentMethod',
  'status',
  'companyId',
  'salesOrderItemId',
  'remarks',
]

// 行状态胶囊:待安排灰、已安排蓝、已完成绿;已下单布尔徽标
const GRID_OVERRIDES = {
  status: {
    enumColors: {
      PENDING: 'default',
      SCHEDULED: 'accent',
      COMPLETED: 'success',
    },
  },
  salesOrderItemId: { label: '来源销售条目' },
  orderedQty: { label: '已下单数量' },
  receivedQty: { label: '已收数量' },
  // 布尔列展示为「已下单」文案(true 时胶囊,同报价「已过期」派生徽标语义)
  ordered: {
    label: '状态徽标',
    render: (v) => (v === true || v === 'true' ? '已下单' : undefined),
  },
} satisfies Record<string, ColumnOverride>

function DemandItemsTab() {
  const perms = useMyPermissions()
  // 行操作成功后刷新当下网格:refetch 由 rowActions 的 ctx 提供,经 ref 传给 hooks 的 after
  const refetchRef = useRef<() => void>(() => {})
  const itemActions = useDemandItemActions(() => refetchRef.current())

  const canCreateWorkOrder = perms.data?.has('mfg.work_order:create') ?? false

  return (
    <>
      <SynieDataGrid
        resource="mfgDemandItems"
        client={demandItemClient}
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        // mfgDemandItems 复用 mfg.demand 权限码,meta capabilities 为空:显式声明本视图
        // 可用动作(complete/change_fulfillment 复用 update 码);不声明 create/delete,
        // 行的增删在需求单抽屉内进行
        capabilities={['update']}
        rowActions={[
          {
            key: 'complete',
            label: '完成',
            capability: 'update',
            onAction: (row, ctx) => {
              refetchRef.current = ctx.refetch
              itemActions.requestComplete(row)
            },
          },
          {
            key: 'changeFulfillment',
            label: '改履约方式',
            capability: 'update',
            onAction: (row, ctx) => {
              refetchRef.current = ctx.refetch
              itemActions.requestChange(row)
            },
          },
          // 「生成工单」挂工单 create 权限码,与需求行 update 分开授权(计划/车间分权)
          ...(canCreateWorkOrder
            ? [
                {
                  key: 'generateWorkOrder',
                  label: '生成工单',
                  onAction: (row: Row, ctx: { refetch: () => void }) => {
                    refetchRef.current = ctx.refetch
                    itemActions.requestGenerate(row)
                  },
                },
              ]
            : []),
        ]}
        actionVisible={{
          complete: canCompleteItem,
          changeFulfillment: canChangeFulfillmentItem,
          generateWorkOrder: canGenerateWorkOrder,
        }}
      />
      {itemActions.dialogs}
    </>
  )
}
