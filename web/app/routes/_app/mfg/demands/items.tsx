import { useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
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

// 快照列展示物料/单位(防主数据改名影响历史行);fk 列走 join 标签;
// 物料按全站约定合并为单个富单元格列(materialCode 列承载,其余快照字段经 extraFields 取回)
const GRID_COLUMNS = [
  'demandId',
  'materialCode',
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
  // 物料列:全站统一富单元格(图纸缩略图+快照编号/名称/规格);需求行无图纸挂接,缩略图回退物料当前图纸
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender(),
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
        // 物料富单元格所需快照字段与物料外键(撤列后仍随查询取回;需求行无 customerPartNo 快照)
        extraFields={['materialId', 'materialName', 'materialSpec']}
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
