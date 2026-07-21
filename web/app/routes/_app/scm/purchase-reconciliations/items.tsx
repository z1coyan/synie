import { createFileRoute } from '@tanstack/react-router'
import { formatAmount, formatQty } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useReconciliationDrawer } from './-reconciliation-drawer'

export const Route = createFileRoute('/_app/scm/purchase-reconciliations/items')({
  component: ReconciliationItemsTab,
})

const GRID_OVERRIDES = {
  reconciliationStatus: {
    label: '对账单状态',
    enumColors: { DRAFT: 'default', CONFIRMED: 'accent', CLOSED: 'success', VOIDED: 'danger' },
  },
  receiptNo: { label: '入库单号' },
  orderCurrencyCode: { label: '币种' },
  // 物料用快照列多行展示,不 join inv.material(避免无物料读权限时整表失败);
  // 编号/规格/客户料号不在行 calculation 上,此处只有名称单行
  materialName: { label: '物料' },
  unitName: { label: '单位' },
  qty: { label: '数量', render: (v: unknown) => formatQty(v) || undefined },
  baseQty: { label: '折算数量', render: (v: unknown) => formatQty(v) || undefined },
  amount: { label: '金额(原币)', render: (v: unknown) => formatAmount(v) },
  baseAmount: { label: '本币金额', render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点会触发嵌套授权的 fk
const GRID_COLUMNS = [
  'companyId',
  'reconciliationNo',
  'reconciliationStatus',
  'receiptNo',
  'receiptDate',
  'materialName',
  'unitName',
  'qty',
  'baseQty',
  'amount',
  'baseAmount',
  'orderCurrencyCode',
]

// 行编辑仅草稿单放行(后端权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = {
  edit: (row: Row) => row.reconciliationStatus === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function ReconciliationItemsTab() {
  const openDrawer = useReconciliationDrawer()

  return (
    <SynieDataGrid
      resource="purReconciliationItems"
      columns={GRID_COLUMNS}
      overrides={GRID_OVERRIDES}
      defaultSort={{ column: 'receiptDate', direction: 'descending' }}
      // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 reconciliationId 为 undefined 过滤报错)
      extraFields={['reconciliationId']}
      // purReconciliationItems 复用 purchase.reconciliation 权限码,meta capabilities 为空:显式声明本视图
      // 可用动作(整单「新建对账单」+ 草稿单「编辑」),不声明 delete,删除不进条目视图
      capabilities={['create', 'update']}
      createLabel="新建对账单"
      onCreate={() => openDrawer('create', null)}
      onView={(row) => {
        if (row.reconciliationId == null || row.reconciliationId === '') return
        openDrawer('view', {
          id: String(row.reconciliationId),
          status: row.reconciliationStatus,
        })
      }}
      onEdit={(row) => {
        if (row.reconciliationId == null || row.reconciliationId === '') return
        openDrawer(row.reconciliationStatus === 'DRAFT' ? 'edit' : 'view', {
          id: String(row.reconciliationId),
          status: row.reconciliationStatus,
        })
      }}
      actionVisible={ACTION_VISIBLE}
    />
  )
}
