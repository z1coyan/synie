import { createFileRoute } from '@tanstack/react-router'
import { formatAmount, formatQty } from '~/lib/amount'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import { docActionVisible, RECONCILIATION_DOC_STATUS_ENUM_COLORS } from '~/lib/doc-status'
import { useReconciliationDrawer } from './-reconciliation-drawer'

export const Route = createFileRoute('/_app/sales/reconciliations/items')({
  component: ReconciliationItemsTab,
})

const GRID_OVERRIDES = {
  // 卡片:物料标题、对账单号副标题、状态/数量/金额摘要
  companyId: { mobileRole: 'hide' },
  reconciliationNo: { mobileRole: 'subtitle' },
  reconciliationStatus: {
    label: '对账单状态',
    mobileRole: 'summary',
    enumColors: RECONCILIATION_DOC_STATUS_ENUM_COLORS,
  },
  deliveryNo: { label: '发货单号' },
  orderCurrencyCode: { label: '币种' },
  // 物料用快照列多行展示,不 join inv.material(避免无物料读权限时整表失败);
  // 编号/规格/客户料号不在行 calculation 上,此处只有名称单行
  materialName: { label: '物料', mobileRole: 'title' },
  unitName: { label: '单位' },
  qty: { label: '数量', mobileRole: 'summary', render: (v: unknown) => formatQty(v) || undefined },
  baseQty: {
    label: '折算数量',
    render: (v: unknown) => formatQty(v) || undefined,
  },
  amount: { label: '金额(原币)', mobileRole: 'summary', render: (v: unknown) => formatAmount(v) },
  baseAmount: { label: '本币金额', render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点会触发嵌套授权的 fk
const GRID_COLUMNS = [
  'companyId',
  'reconciliationNo',
  'reconciliationStatus',
  'deliveryNo',
  'deliveryDate',
  'materialName',
  'unitName',
  'qty',
  'baseQty',
  'amount',
  'baseAmount',
  'orderCurrencyCode',
]

// 行编辑仅草稿单放行(后端权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = docActionVisible({ edit: ['DRAFT'] }, 'reconciliationStatus')

function ReconciliationItemsTab() {
  const openDrawer = useReconciliationDrawer()

  return (
    <SynieDataGrid
      resource="salReconciliationItems"
      columns={GRID_COLUMNS}
      overrides={GRID_OVERRIDES}
      defaultSort={{ column: 'deliveryDate', direction: 'descending' }}
      // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 reconciliationId 为 undefined 过滤报错)
      extraFields={['reconciliationId']}
      // salReconciliationItems 复用 sales.reconciliation 权限码,meta capabilities 为空:显式声明本视图
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
