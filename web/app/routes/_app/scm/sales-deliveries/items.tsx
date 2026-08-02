import { createFileRoute } from '@tanstack/react-router'
import { formatQty } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { AUDIT_DOC_STATUS_ENUM_COLORS, docActionVisible } from '~/lib/doc-status'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useAuditDoc } from '../-audit-doc'
import { deliveryAuditConfig, useDeliveryDrawer } from './-delivery-drawer'

export const Route = createFileRoute('/_app/scm/sales-deliveries/items')({
  component: DeliveryItemsTab,
})

const GRID_OVERRIDES = {
  // 卡片:物料标题、客户副标题、状态/数量/发货单号摘要;公司与对手类型桌面保留
  companyId: { mobileRole: 'hide' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  deliveryStatus: {
    label: '发货状态',
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  deliveryNo: { mobileRole: 'summary' },
  orderNo: { label: '订单号' },
  partyId: { mobileRole: 'subtitle' },
  // 物料列:全站统一富单元格(图纸缩略图+快照四字段,编号点开物料速览);行图纸挂接优先,
  // 快照文本不 join inv.material(避免无物料读权限时整表失败)
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender({ drawingOwnerType: 'sal_delivery_item' }),
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
  'deliveryNo',
  'deliveryDate',
  'deliveryStatus',
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
const ACTION_VISIBLE = docActionVisible({ edit: ['DRAFT'], auditDoc: ['DRAFT'] }, 'deliveryStatus')

function DeliveryItemsTab() {
  const openDrawer = useDeliveryDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(deliveryAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="salDeliveryItems"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'deliveryDate', direction: 'descending' }}
        // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 deliveryId 为 undefined 过滤报错);
        // 物料富单元格所需快照字段与物料外键一并补取(图纸缩略图已并入物料单元格)
        extraFields={['deliveryId', 'materialId', 'materialName', 'materialSpec', 'customerPartNo']}
        // salDeliveryItems 复用 sales.delivery 权限码,meta capabilities 为空:显式声明本视图
        // 可用动作(整单「新建发货单」+ 草稿单「编辑/审核整单」),不声明 delete,删除不进条目视图
        capabilities={['create', 'update', 'audit']}
        createLabel="新建发货单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => {
          if (row.deliveryId == null || row.deliveryId === '') return
          openDrawer('view', {
            id: String(row.deliveryId),
            status: row.deliveryStatus,
          })
        }}
        onEdit={(row) => {
          if (row.deliveryId == null || row.deliveryId === '') return
          openDrawer(row.deliveryStatus === 'DRAFT' ? 'edit' : 'view', {
            id: String(row.deliveryId),
            status: row.deliveryStatus,
          })
        }}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.deliveryId == null || row.deliveryId === '') return
              requestAudit(String(row.deliveryId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
