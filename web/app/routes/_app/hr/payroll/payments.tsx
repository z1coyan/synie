import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'
import { useCatalogBasicForm } from '~/lib/resources/catalog'
import { PAYROLL_PAYMENT_KIND_ENUM_COLORS } from '~/lib/doc-status'
import { resourceBindingFor } from '~/lib/resources/registry'

export const Route = createFileRoute('/_app/hr/payroll/payments')({
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
  const [viewRow, setViewRow] = useState<Row | null>(null)
  const queryClient = useQueryClient()
  const paymentForm = useCatalogBasicForm('hrPayrollPayments', '工资发放')

  // 删除发放会翻转工资单状态并联动借款台账,一并失效
  const invalidateAll = () => {
    for (const resource of ['hrPayrolls', 'hrPayrollPayments', 'hrEmployeeLoans']) {
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
          resource="hrPayrollPayments"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'paidOn', direction: 'descending' }}
          onView={(row) => setViewRow(row)}
          onMutated={invalidateAll}
        />
      </div>

      <SynieRecordDrawer
        resource="hrPayrollPayments"
        label={paymentForm.formProps.label}
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        rowId={viewRow?.id}
      />
    </>
  )
}
