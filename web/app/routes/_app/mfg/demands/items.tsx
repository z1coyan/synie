import { useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { demandItemClient } from '~/lib/resources/manufacturing'
import { hasPermission } from '~/lib/permissions'
import {
  canGenerateWorkOrder,
  useDemandItemActions,
  useMyPermissions,
} from './-item-actions'
import { useDemandDrawer } from './-demand-drawer'

export const Route = createFileRoute('/_app/mfg/demands/items')({
  component: DemandItemsTab,
})

/**
 * 需求行行视图:跨单混排;列筛选待安排/已完成、剩余可安排、公司。
 * 行操作:生成工单(可分批多张)。完成语义走安排/入库,无点完成/履约方式。
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
  'arrangedQty',
  'completedQty',
  'remainingArrangeableQty',
  'orderedQty',
  'receivedQty',
  'needDate',
  'status',
  'companyId',
  'salesOrderItemId',
  'remarks',
]

// 行状态胶囊:待安排灰、已安排蓝、已完成绿
// 卡片:物料标题、状态副标题、需求日/数量摘要
const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  materialCode: { mobileRole: 'hide' },
  materialSpec: { mobileRole: 'hide' },
  materialName: {
    mobileRole: 'title',
    render: (_v, row) => {
      const code = row.materialCode != null ? String(row.materialCode) : ''
      const name = row.materialName != null ? String(row.materialName) : ''
      const text = [code, name].filter(Boolean).join(' ')
      return text || undefined
    },
  },
  status: {
    mobileRole: 'subtitle',
    enumColors: {
      PENDING: 'default',
      SCHEDULED: 'accent',
      COMPLETED: 'success',
    },
  },
  needDate: { mobileRole: 'summary' },
  remainingArrangeableQty: { mobileRole: 'summary', label: '剩余可安排' },
  arrangedQty: { label: '已安排' },
  completedQty: { label: '已完成' },
  qty: { mobileRole: 'summary' },
  salesOrderItemId: { label: '来源销售条目' },
  orderedQty: { label: '已下单数量' },
  receivedQty: { label: '已收数量' },
} satisfies Record<string, ColumnOverride>

function DemandItemsTab() {
  const openDrawer = useDemandDrawer()
  const perms = useMyPermissions()
  const refetchRef = useRef<() => void>(() => {})
  const itemActions = useDemandItemActions(() => refetchRef.current())

  const canCreateDemand = hasPermission(perms.data, 'mfg.demand:create')
  const canCreateWorkOrder = hasPermission(
    perms.data,
    'mfg.work_order:create',
  )

  return (
    <>
      <SynieDataGrid
        resource="mfgDemandItems"
        client={demandItemClient}
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        capabilities={[...(canCreateDemand ? ['create'] : [])]}
        createLabel="新建需求单"
        onCreate={() => openDrawer('create', null)}
        rowActions={[
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
          generateWorkOrder: canGenerateWorkOrder,
        }}
      />
      {itemActions.dialogs}
    </>
  )
}
