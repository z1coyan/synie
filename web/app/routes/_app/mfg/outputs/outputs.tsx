import { createFileRoute } from '@tanstack/react-router'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import {
  AUDIT_DOC_ACTION_VISIBLE,
  AUDIT_DOC_STATUS_ENUM_COLORS,
} from '~/lib/doc-status'
import { useAuditDoc } from '../../scm/-audit-doc'
import { outputAuditConfig, useOutputDrawer } from './-output-drawer'

export const Route = createFileRoute('/_app/mfg/outputs/outputs')({
  component: OutputsTab,
})

const GRID_COLUMNS = [
  'companyId',
  'outputNo',
  'outputDate',
  'warehouseId',
  'status',
  'remarks',
]

// 卡片:单号标题、日期副标题、状态/仓库摘要
const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  outputNo: { mobileRole: 'title' },
  outputDate: { mobileRole: 'subtitle' },
  status: {
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  warehouseId: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

const ACTION_VISIBLE = AUDIT_DOC_ACTION_VISIBLE

function OutputsTab() {
  const openDrawer = useOutputDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(outputAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="mfgOutputs"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'outputDate', direction: 'descending' }}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) =>
          openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)
        }
        // 审核改走「列出全部条目核对」的确认弹窗(与条目页「审核整单」同一套)
        actionHandlers={{
          audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch),
        }}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
