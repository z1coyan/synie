import { createFileRoute } from '@tanstack/react-router'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { DEMAND_DOC_STATUS_ENUM_COLORS } from '~/lib/doc-status'
import {
  DEMAND_AUDIT_CONFIG,
  useDemandDrawer,
} from './-demand-drawer'
import { useDispatchDemand } from './-dispatch-dialog'
import { useAuditDoc } from '../../scm/-audit-doc'

export const Route = createFileRoute('/_app/mfg/demands/orders')({
  component: DemandOrdersTab,
})

const GRID_COLUMNS = [
  'demandNo',
  'demandDate',
  'companyId',
  'assignedDeptId',
  'status',
  'remarks',
]

// 状态机动作显隐（后端权威校验兜底）：审核/删除/编辑仅草稿；
// 关闭/作废/下发车间仅已确认(后端已收紧:草稿不可作废,走删除;草稿改车间走表单)
const ACTION_VISIBLE = {
  edit: (row: Row) => row.status === 'DRAFT',
  audit: (row: Row) => row.status === 'DRAFT',
  close: (row: Row) => row.status === 'CONFIRMED',
  void: (row: Row) => row.status === 'CONFIRMED',
  dispatch: (row: Row) => row.status === 'CONFIRMED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// 状态胶囊配色:草稿灰、已确认绿、已关闭黄、已作废红
// 卡片:需求单号标题、日期副标题、状态/公司摘要
const GRID_OVERRIDES = {
  demandNo: { mobileRole: 'title' },
  demandDate: { mobileRole: 'subtitle' },
  status: {
    mobileRole: 'summary',
    enumColors: DEMAND_DOC_STATUS_ENUM_COLORS,
  },
  companyId: { mobileRole: 'summary' },
  // 下发车间:未下发即空,车间经理按此列看到本车间的单
  assignedDeptId: { label: '下发车间', mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

function DemandOrdersTab() {
  const openDrawer = useDemandDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(DEMAND_AUDIT_CONFIG)
  const { requestDispatch, dispatchDialog } = useDispatchDemand()

  return (
    <>
      <SynieDataGrid
        resource="mfgDemands"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) =>
          openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)
        }
        actionHandlers={{
          audit: (rows, ctx) =>
            requestAudit(String(rows[0].id), ctx.refetch),
          dispatch: (rows, ctx) => requestDispatch(rows[0], ctx.refetch),
        }}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
      {dispatchDialog}
    </>
  )
}
