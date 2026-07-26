import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner, Table, toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import {
  employeeLoanClient,
  fetchEmployeeLoanBalances,
  saveEmployeeLoan,
  type EmployeeLoanBalance,
} from '~/lib/resources/hr-operations'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/hr/payroll/loans')({
  component: EmployeeLoansPage,
})

type BalanceRow = EmployeeLoanBalance

const GRID_COLUMNS = ['employeeId', 'kind', 'occurredOn', 'amount', 'payrollId', 'remarks', 'createdById']

const GRID_OVERRIDES = {
  kind: { enumColors: { BORROW: 'warning', REPAY: 'success' } },
} satisfies Record<string, ColumnOverride>

function EmployeeLoansPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  const balances = useQuery({
    queryKey: ['loanBalances'],
    queryFn: fetchEmployeeLoanBalances,
  })

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrEmployeeLoans'] })
    void queryClient.invalidateQueries({ queryKey: ['rowById', 'hrEmployeeLoans'] })
    void queryClient.invalidateQueries({ queryKey: ['loanBalances'] })
  }

  const rows = balances.data ?? []
  const totalBalance = rows.reduce((acc, r) => acc + Number(r.balance || 0), 0)

  return (
    <>
      <p className="text-sm text-ink-500">
        员工借款/预支与归还的流水台账,余额 = Σ借款 − Σ归还。工资单发放时按借款抵扣自动生成归还行
        (带关联工资单),该类行不可手改手删,随发放回退自动撤销;现金还款手工录归还行。
      </p>

      {rows.length > 0 && (
        <div className="mt-4">
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label="员工借款余额">
                <Table.Header>
                  <Table.Column isRowHeader>员工编号</Table.Column>
                  <Table.Column>姓名</Table.Column>
                  <Table.Column className="text-end">累计借款</Table.Column>
                  <Table.Column className="text-end">累计归还</Table.Column>
                  <Table.Column className="text-end">余额</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((r) => (
                    <Table.Row key={r.employeeId}>
                      <Table.Cell>{r.employeeCode ?? '—'}</Table.Cell>
                      <Table.Cell>{r.employeeName ?? '—'}</Table.Cell>
                      <Table.Cell className="text-end">{formatAmount(r.borrowed)}</Table.Cell>
                      <Table.Cell className="text-end">{formatAmount(r.repaid)}</Table.Cell>
                      <Table.Cell className="text-end font-medium">{formatAmount(r.balance)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          {/* 合计条(Table.Footer 是 div 容器装不了 react-aria Row,照 DataGrid pageSummary 形态另起一行) */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-sm text-muted">
            <span className="font-medium">合计 {rows.length} 人</span>
            <span className="font-medium">余额合计 {formatAmount(String(totalBalance))}</span>
          </div>
        </div>
      )}
      {balances.isLoading && (
        <div className="flex justify-center py-6">
          <Spinner aria-label="加载中" />
        </div>
      )}

      <div className="mt-4">
        <SynieDataGrid
          resource="hrEmployeeLoans"
          client={employeeLoanClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'occurredOn', direction: 'descending' }}
          createLabel="记一笔"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          // 发放联动行不可改:直接进只读详情
          onEdit={(row) => setDrawer({ mode: row.payrollId ? 'view' : 'edit', row })}
          onMutated={invalidateAll}
        />
      </div>

      <SynieRecordDrawer
        {...drawerConfig('hrEmployeeLoans')}
        resource="hrEmployeeLoans"
        client={employeeLoanClient}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d && !d.row?.payrollId ? { ...d, mode: 'edit' } : d))}
        exclude={['createdById', 'payrollId']}
        fields={{
          ...drawerConfig('hrEmployeeLoans').fields,
          employeeId: { required: true, order: -3 },
          kind: { required: true, order: -2, defaultValue: 'BORROW' },
          occurredOn: { required: true, order: -1 },
          amount: { required: true },
          remarks: { placeholder: '如 预支生活费、现金还款' },
        }}
        onSubmit={async (values, mode) => {
          const input = {
            employeeId: values.employeeId,
            kind: values.kind,
            occurredOn: values.occurredOn,
            amount: values.amount,
            remarks: values.remarks,
          }

          await saveEmployeeLoan(
            mode === 'create' ? null : drawer!.row!.id,
            input,
          )
          toast.success(mode === 'create' ? '台账已记账' : '台账已更新')
          invalidateAll()
        }}
      />
    </>
  )
}
