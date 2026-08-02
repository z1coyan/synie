import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { useCatalogBasicForm } from '~/lib/resources/catalog'
import { PAYROLL_PAYMENT_KIND_ENUM_COLORS } from '~/lib/doc-status'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

const RESOURCE = 'hrPayrollPayments'

export const Route = createFileRoute('/_app/hr/payroll/payments')({
  // defaultSort:跳过默认首屏 loader
  component: PayrollPaymentsPage,
})

const GRID_COLUMNS = ['employeeId', 'month', 'paidOn', 'kind', 'amount', 'payrollId', 'remarks', 'createdById']

// 卡片:员工标题、月份副标题、金额/发放日/类型摘要
const GRID_OVERRIDES = {
  employeeId: { mobileRole: 'title' },
  month: { mobileRole: 'subtitle' },
  amount: { mobileRole: 'summary' },
  paidOn: { mobileRole: 'summary' },
  kind: {
    mobileRole: 'summary',
    enumColors: PAYROLL_PAYMENT_KIND_ENUM_COLORS,
  },
} satisfies Record<string, ColumnOverride>

function PayrollPaymentsPage() {
  // 只读详情抽屉;mode 固定 view(无 create/edit)
  const { drawer, open, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const paymentForm = useCatalogBasicForm(RESOURCE, '工资发放')

  // 删除发放会翻转工资单状态并联动借款台账,一并失效
  const invalidateAll = () => {
    for (const resource of ['hrPayrolls', RESOURCE, 'hrEmployeeLoans']) {
      void resourceBindingFor(resource).cache.invalidateAll(queryClient)
    }
    void queryClient.invalidateQueries({ queryKey: ['payrollMonthStats'] })
    void queryClient.invalidateQueries({ queryKey: ['payrollPayments'] })
    void queryClient.invalidateQueries({ queryKey: ['loanBalances'] })
  }

  return (
    <>
      <p className="text-sm text-ink-500">
        全量发放流水:一张工资单可多条(首笔=发放,其后=补发,负数为冲回)。登记入口在工资单抽屉;
        记录不可改,删错了从工资单侧重新登记,全删后该单自动翻回待发放。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'paidOn', direction: 'descending' }}
          onView={(row) => open('view', String(row.id))}
          onMutated={invalidateAll}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={paymentForm.formProps.label}
        mode="view"
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
      />
    </>
  )
}
