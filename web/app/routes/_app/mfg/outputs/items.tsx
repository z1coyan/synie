import { createFileRoute } from '@tanstack/react-router'
import { formatQty } from '~/lib/amount'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import {
  AUDIT_DOC_STATUS_ENUM_COLORS,
  docActionVisible,
} from '~/lib/doc-status'
import { useAuditDoc } from '../../scm/-audit-doc'
import { outputAuditConfig, useOutputDrawer } from './-output-drawer'

export const Route = createFileRoute('/_app/mfg/outputs/items')({
  component: OutputItemsTab,
})

const GRID_OVERRIDES = {
  // 卡片:物料标题、工单副标题、状态/数量/单号摘要
  companyId: { mobileRole: 'hide' },
  outputStatus: {
    label: '入库状态',
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  outputNo: { mobileRole: 'summary' },
  workOrderId: { mobileRole: 'subtitle' },
  // 物料列:全站统一富单元格;生产入库条目无图纸挂接,缩略图回退物料当前图纸
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender(),
  },
  unitName: { label: '单位' },
  qty: {
    label: '数量',
    mobileRole: 'summary',
    render: (v: unknown) => formatQty(v) || undefined,
  },
  baseQty: {
    label: '折算数量',
    render: (v: unknown) => formatQty(v) || undefined,
  },
  warehouseId: { label: '入库仓库' },
} satisfies Record<string, ColumnOverride>

// 列走行上快照/计算字段 + 工单 fk;不点 materialId 等会触发嵌套授权的 fk
const GRID_COLUMNS = [
  'companyId',
  'outputNo',
  'outputDate',
  'outputStatus',
  'workOrderId',
  'materialCode',
  'unitName',
  'qty',
  'baseQty',
  'warehouseId',
]

// 行编辑/审核整单仅草稿单放行;删除不进条目视图
const ACTION_VISIBLE = docActionVisible(
  { edit: ['DRAFT'], auditDoc: ['DRAFT'] },
  'outputStatus',
)

function OutputItemsTab() {
  const openDrawer = useOutputDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(outputAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="mfgOutputItems"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'outputDate', direction: 'descending' }}
        // 开抽屉需要母单 id;物料富单元格所需快照字段与外键一并补取
        extraFields={[
          'outputId',
          'materialId',
          'materialName',
          'materialSpec',
        ]}
        // mfgOutputItems 复用 mfg.output 权限码,meta capabilities 为空:显式声明本视图
        // 可用动作(整单「新建入库单」+ 草稿单「编辑/审核整单」),不声明 delete
        capabilities={['create', 'update', 'audit']}
        createLabel="新建入库单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => {
          if (row.outputId == null || row.outputId === '') return
          openDrawer('view', {
            id: String(row.outputId),
            status: row.outputStatus,
          })
        }}
        onEdit={(row) => {
          if (row.outputId == null || row.outputId === '') return
          openDrawer(row.outputStatus === 'DRAFT' ? 'edit' : 'view', {
            id: String(row.outputId),
            status: row.outputStatus,
          })
        }}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.outputId == null || row.outputId === '') return
              requestAudit(String(row.outputId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
