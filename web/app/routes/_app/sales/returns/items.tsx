import { createFileRoute } from '@tanstack/react-router'
import { formatQty } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { AUDIT_DOC_STATUS_ENUM_COLORS, docActionVisible } from '~/lib/doc-status'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useAuditDoc } from '../../scm/-audit-doc'
import { returnAuditConfig, useReturnDrawer } from './-return-drawer'

export const Route = createFileRoute('/_app/sales/returns/items')({
  component: ReturnItemsTab,
})

const GRID_OVERRIDES = {
  // 卡片:物料标题、客户副标题、状态/数量/退货单号摘要;公司与对手类型桌面保留
  companyId: { mobileRole: 'hide' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  returnStatus: {
    label: '退货状态',
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  returnNo: { mobileRole: 'summary' },
  orderNo: { label: '订单号' },
  partyId: { mobileRole: 'subtitle' },
  // 物料列:全站统一富单元格(图纸缩略图+快照四字段,编号点开物料速览);行图纸挂接优先,
  // 快照文本不 join inv.material(避免无物料读权限时整表失败)
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender({ drawingOwnerType: 'sal_return_item' }),
  },
  unitName: { label: '单位' },
  qty: { label: '数量', mobileRole: 'summary', render: (v: unknown) => formatQty(v) || undefined },
  baseQty: { label: '折算数量', render: (v: unknown) => formatQty(v) || undefined },
  reconciledQty: { label: '已对账数量', render: (v: unknown) => formatQty(v) || undefined },
  remainingReconcilableQty: { label: '剩余可对账', render: (v: unknown) => formatQty(v) || undefined },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点 materialId 等会触发嵌套授权的 fk;
// 物料按全站约定合并为单个富单元格列(materialCode 列承载,其余快照字段经 extraFields 取回)
const GRID_COLUMNS = [
  'companyId',
  'returnNo',
  'returnDate',
  'returnStatus',
  'orderNo',
  'partyType',
  'partyId',
  'materialCode',
  'unitName',
  'qty',
  'baseQty',
  'reconciledQty',
  'remainingReconcilableQty',
]

// 行编辑/审核整单仅草稿单放行(后端权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = docActionVisible({ edit: ['DRAFT'], auditDoc: ['DRAFT'] }, 'returnStatus')

function ReturnItemsTab() {
  const openDrawer = useReturnDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(returnAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="salReturnItems"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'returnDate', direction: 'descending' }}
        // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 returnId 为 undefined 过滤报错);
        // 物料富单元格所需快照字段与物料外键一并补取(图纸缩略图已并入物料单元格)
        extraFields={['returnId', 'materialId', 'materialName', 'materialSpec', 'customerPartNo']}
        createLabel="新建退货单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => {
          if (row.returnId == null || row.returnId === '') return
          openDrawer('view', {
            id: String(row.returnId),
            status: row.returnStatus,
          })
        }}
        onEdit={(row) => {
          if (row.returnId == null || row.returnId === '') return
          openDrawer(row.returnStatus === 'DRAFT' ? 'edit' : 'view', {
            id: String(row.returnId),
            status: row.returnStatus,
          })
        }}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.returnId == null || row.returnId === '') return
              requestAudit(String(row.returnId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
