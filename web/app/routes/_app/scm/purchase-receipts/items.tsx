import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { AUDIT_DOC_STATUS_ENUM_COLORS, docActionVisible } from '~/lib/doc-status'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useAuditDoc } from '../-audit-doc'
import { receiptAuditConfig, useReceiptDrawer } from './-receipt-drawer'

export const Route = createFileRoute('/_app/scm/purchase-receipts/items')({
  component: ReceiptItemsTab,
})

const GRID_OVERRIDES = {
  // 卡片:物料标题、供应商副标题、状态/数量/入库单号摘要
  companyId: { mobileRole: 'hide' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  receiptStatus: {
    label: '入库状态',
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
  },
  receiptNo: { mobileRole: 'summary' },
  orderNo: { label: '订单号' },
  partyId: { mobileRole: 'subtitle' },
  // 物料列:全站统一富单元格(图纸缩略图+快照四字段,编号点开物料速览);行图纸挂接优先。
  // 文本严格取行上快照,不 join inv.material(避免无物料读权限时整表失败)
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender({ drawingOwnerType: 'pur_receipt_item' }),
  },
  unitName: { label: '单位' },
  qty: { mobileRole: 'summary' },
  baseQty: { label: '折算数量' },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点 materialId 等会触发嵌套授权的 fk;
// 物料按全站约定合并为单个富单元格列(materialCode 列承载,其余快照字段经 extraFields 取回)
const GRID_COLUMNS = [
  'companyId',
  'receiptNo',
  'receiptDate',
  'receiptStatus',
  'orderNo',
  'partyType',
  'partyId',
  'materialCode',
  'unitName',
  'qty',
  'baseQty',
]

// 行编辑/审核整单仅草稿单放行(后端权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = docActionVisible({ edit: ['DRAFT'], auditDoc: ['DRAFT'] }, 'receiptStatus')

function ReceiptItemsTab() {
  const openDrawer = useReceiptDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(receiptAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purReceiptItems"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'receiptDate', direction: 'descending' }}
        // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 receiptId 为 undefined 过滤报错);
        // 后四个是物料富单元格所需快照字段与物料外键(撤列后仍随查询取回,raw 值不触发嵌套授权)
        extraFields={['receiptId', 'materialId', 'materialName', 'materialSpec', 'customerPartNo']}
        // purReceiptItems 复用 purchase.receipt 权限码,meta capabilities 为空:显式声明本视图
        // 可用动作(整单「新建入库单」+ 草稿单「编辑/审核整单」),不声明 delete,删除不进条目视图
        capabilities={['create', 'update', 'audit']}
        createLabel="新建入库单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => {
          if (row.receiptId == null || row.receiptId === '') return
          openDrawer('view', {
            id: String(row.receiptId),
            status: row.receiptStatus,
          })
        }}
        onEdit={(row) => {
          if (row.receiptId == null || row.receiptId === '') return
          openDrawer(row.receiptStatus === 'DRAFT' ? 'edit' : 'view', {
            id: String(row.receiptId),
            status: row.receiptStatus,
          })
        }}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.receiptId == null || row.receiptId === '') return
              requestAudit(String(row.receiptId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
