import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useAuditDoc } from '../-audit-doc'
import { receiptAuditConfig, useReceiptDrawer } from './-receipt-drawer'

export const Route = createFileRoute('/_app/scm/purchase-receipts/items')({
  component: ReceiptItemsTab,
})

const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  receiptStatus: {
    label: '入库状态',
    enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' },
  },
  orderNo: { label: '订单号' },
  // 物料用快照列多行展示,不 join inv.material(避免无物料读权限时整表失败)
  materialName: {
    label: '物料',
    render: (_v: unknown, r: Row) => {
      const code = r.materialCode != null ? String(r.materialCode) : ''
      const name = r.materialName != null ? String(r.materialName) : ''
      const title = [code, name].filter(Boolean).join(' ')
      if (!title && r.materialSpec == null && r.customerPartNo == null) return undefined
      const spec = r.materialSpec != null && r.materialSpec !== '' ? String(r.materialSpec) : null
      const cpn =
        r.customerPartNo != null && r.customerPartNo !== '' ? String(r.customerPartNo) : null
      return (
        <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
          {title ? <span className="truncate font-medium">{title}</span> : null}
          {spec ? (
            <span className="truncate text-xs text-muted" title={spec}>
              规格 {spec}
            </span>
          ) : null}
          {cpn ? (
            <span className="truncate text-xs text-muted" title={cpn}>
              客户料号 {cpn}
            </span>
          ) : null}
        </div>
      )
    },
  },
  unitName: { label: '单位' },
  baseQty: { label: '折算数量' },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点 materialId 等会触发嵌套授权的 fk
const GRID_COLUMNS = [
  'companyId',
  'receiptNo',
  'receiptDate',
  'receiptStatus',
  'orderNo',
  'partyType',
  'partyId',
  'materialName',
  'unitName',
  'qty',
  'baseQty',
]

// 行编辑/审核整单仅草稿单放行(后端权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = {
  edit: (row: Row) => row.receiptStatus === 'DRAFT',
  auditDoc: (row: Row) => row.receiptStatus === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function ReceiptItemsTab() {
  const openDrawer = useReceiptDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(receiptAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="purReceiptItems"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        // 行图纸:sys_attachment 挂接(owner_type pur_receipt_item / category drawing),与订单条目同机制
        attachmentImages={{ ownerType: 'pur_receipt_item', category: 'drawing', label: '图纸' }}
        defaultSort={{ column: 'receiptDate', direction: 'descending' }}
        // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 receiptId 为 undefined 过滤报错)
        extraFields={['receiptId']}
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
