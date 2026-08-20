import { Outlet, createFileRoute } from '@tanstack/react-router'
import { ReconciliationDrawerProvider } from './reconciliations/-reconciliation-drawer'

export const Route = createFileRoute('/_app/sales/reconciliations')({
  component: SalesReconciliationsLayout,
})

/**
 * 销售对账：仅对账单列表（不设条目视角）。
 * 条目录入与核对在对账单抽屉/确认弹窗内完成。
 */
function SalesReconciliationsLayout() {
  return (
    <ReconciliationDrawerProvider urlSync>
      <h1 className="font-brand text-xl">销售对账</h1>
      <p className="mt-1 text-xs text-ink-500">
        发货与开票之间的勾稽:常规单客户确认后由开出发票关联结单;赠送/样品单审核即结单过账,兼任超发尾差核销。
      </p>
      <div className="mt-4">
        <Outlet />
      </div>
    </ReconciliationDrawerProvider>
  )
}
