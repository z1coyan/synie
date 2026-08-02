import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Spinner, Table, toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import {
  fetchEmployeeLoanBalances,
  type EmployeeLoanBalance,
} from '~/lib/resources/hr-operations'
import { useCatalogBasicForm,
  requireWriter,} from '~/lib/resources/catalog'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { PAYROLL_LOAN_KIND_ENUM_COLORS } from '~/lib/doc-status'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

const RESOURCE = 'hrEmployeeLoans'

export const Route = createFileRoute('/_app/hr/payroll/loans')({
  // defaultSort + 余额汇总多请求:跳过默认首屏 loader
  component: EmployeeLoansPage,
})

type BalanceRow = EmployeeLoanBalance

const GRID_COLUMNS = ['employeeId', 'kind', 'occurredOn', 'amount', 'payrollId', 'remarks', 'createdById']

// 卡片:员工标题、类型副标题、金额/日期摘要
const GRID_OVERRIDES = {
  employeeId: { mobileRole: 'title' },
  kind: {
    mobileRole: 'subtitle',
    enumColors: PAYROLL_LOAN_KIND_ENUM_COLORS,
  },
  amount: { mobileRole: 'summary' },
  occurredOn: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

function EmployeeLoansPage() {
  const { drawer, open, setMode, close, row: drawerRow } =
    useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '员工借款')

  const balances = useQuery({
    queryKey: ['loanBalances'],
    queryFn: fetchEmployeeLoanBalances,
  })

  const invalidateAll = () => {
    void binding.cache.invalidateAll(queryClient)
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
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'occurredOn', direction: 'descending' }}
          createLabel="记一笔"
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          // 发放联动行不可改:直接进只读详情
          onEdit={(row) =>
            open(row.payrollId ? 'view' : 'edit', String(row.id))
          }
          onMutated={invalidateAll}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        onEdit={() => {
          // 发放联动行不可改
          if (drawerRow?.payrollId) return
          setMode('edit')
        }}
        exclude={formProps.exclude}
        fields={formProps.fields}
        onSubmit={async (values, mode) => {
          const input = {
            employeeId: values.employeeId,
            kind: values.kind,
            occurredOn: values.occurredOn,
            amount: values.amount,
            remarks: values.remarks,
          }

          if (mode === 'create') {
            await requireWriter(binding, 'create', '员工借款')(input)
          } else {
            await requireWriter(binding, 'update', '员工借款')(
              String(drawer!.recordId),
              input,
            )
          }
          toast.success(mode === 'create' ? '台账已记账' : '台账已更新')
          invalidateAll()
        }}
      />
    </>
  )
}
