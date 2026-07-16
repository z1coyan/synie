import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Chip, Spinner, Table, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'
import { PAYMENT_KIND_LABELS } from './-shared'

const FETCH_PAYMENTS = `
  query ($payrollId: ID!) {
    hrPayrollPayments(filter: {payrollId: {eq: $payrollId}}, sort: [{field: PAID_ON, order: ASC}], limit: 200, offset: 0) {
      results { id paidOn amount kind remarks }
    }
  }
`
const CREATE_PAYMENT = `
  mutation ($input: CreateHrPayrollPaymentInput!) {
    createHrPayrollPayment(input: $input) { result { id } errors { message } }
  }
`
const DESTROY_PAYMENT = `
  mutation ($id: ID!) {
    destroyHrPayrollPayment(id: $id) { result { id } errors { message } }
  }
`

interface PaymentRow {
  id: string
  paidOn: string
  amount: string
  kind: 'NORMAL' | 'SUPPLEMENT'
  remarks: string | null
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 工资单抽屉的发放记录区:列表 + 登记发放/补发(二级抽屉)+ 删除。
 * 发放/删除会翻转工资单状态并联动借款台账,变更后由 onChanged 失效关联缓存。
 */
export function PaymentsSection(props: { payroll: Row; onChanged: () => void }) {
  const payrollId = props.payroll.id
  const [createOpen, setCreateOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const queryClient = useQueryClient()

  // 门控按 hrPayrollPayments 自身权限码(发放≠改单)
  const meta = useGridMeta('hrPayrollPayments')
  const can = (action: string) => (meta.data?.capabilities ?? []).includes(action)

  const payments = useQuery({
    queryKey: ['payrollPayments', payrollId],
    queryFn: () => gqlFetch<{ hrPayrollPayments: { results: PaymentRow[] } }>(FETCH_PAYMENTS, { payrollId }),
    select: (d) => d.hrPayrollPayments.results,
  })

  const rows = payments.data ?? []
  const paidSum = rows.reduce((acc, r) => acc + Number(r.amount || 0), 0)
  const payable = Number(props.payroll.payable || 0)
  const diff = payable - paidSum
  const isPaid = props.payroll.status === 'PAID'

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['payrollPayments', payrollId] })
    props.onChanged()
  }

  const remove = async (row: PaymentRow) => {
    setDeleting(row.id)
    try {
      const data = await gqlFetch<{ destroyHrPayrollPayment: { errors: { message: string }[] | null } }>(
        DESTROY_PAYMENT,
        { id: row.id },
      )
      const errors = data.destroyHrPayrollPayment.errors
      if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
      toast.success('发放记录已删除;该单已无发放记录时自动翻回待发放')
      refreshAll()
    } catch (e) {
      toast.danger('删除失败', { description: (e as Error).message })
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">发放记录</span>
        {can('create') && (
          <Button size="sm" variant="secondary" onPress={() => setCreateOpen(true)}>
            {isPaid ? '登记补发' : '登记发放'}
          </Button>
        )}
      </div>

      {payments.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner aria-label="加载中" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted">尚未发放;登记首笔发放后本单标记为已发放。</p>
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label="发放记录">
              <Table.Header>
                <Table.Column isRowHeader>发放日期</Table.Column>
                <Table.Column>类型</Table.Column>
                <Table.Column className="text-end">金额</Table.Column>
                <Table.Column>备注</Table.Column>
                <Table.Column> </Table.Column>
              </Table.Header>
              <Table.Body>
                {rows.map((r) => (
                  <Table.Row key={r.id}>
                    <Table.Cell>{r.paidOn}</Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" color={r.kind === 'NORMAL' ? 'success' : 'accent'}>
                        {PAYMENT_KIND_LABELS[r.kind] ?? r.kind}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell className={`text-end ${Number(r.amount) < 0 ? 'text-danger' : ''}`}>
                      {formatAmount(r.amount)}
                    </Table.Cell>
                    <Table.Cell>{r.remarks ?? '—'}</Table.Cell>
                    <Table.Cell className="text-end">
                      {can('delete') && (
                        <Button
                          size="sm"
                          variant="tertiary"
                          isDisabled={deleting === r.id}
                          onPress={() => void remove(r)}
                        >
                          删除
                        </Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      {/* 合计条(照考勤月汇总先例,表格外另起一行) */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-sm text-muted">
        <span>应发 {formatAmount(props.payroll.payable)}</span>
        <span>已发 {formatAmount(String(paidSum))}</span>
        <span className={diff !== 0 ? 'font-medium text-warning' : ''}>差额 {formatAmount(String(diff))}</span>
      </div>

      {/* 登记发放/补发:二级抽屉复用 RecordDrawer 表单机制;payrollId 固定注入不进表单 */}
      <SynieRecordDrawer
        resource="hrPayrollPayments"
        label={isPaid ? '补发' : '发放'}
        mode="create"
        isOpen={createOpen}
        onOpenChange={(open) => !open && setCreateOpen(false)}
        exclude={['payrollId', 'employeeId', 'month', 'kind', 'createdById', 'insertedAt', 'updatedAt']}
        fields={{
          paidOn: { required: true, order: 0, defaultValue: today() },
          // 默认带出未发差额(补发场景即漏算差额);冲回填负数
          amount: { required: true, order: 1, defaultValue: diff !== 0 ? String(diff) : undefined },
          remarks: { order: 2, placeholder: isPaid ? '如 考勤漏算补发' : undefined },
        }}
        onSubmit={async (values) => {
          const input = { payrollId, paidOn: values.paidOn, amount: values.amount, remarks: values.remarks }
          const data = await gqlFetch<{ createHrPayrollPayment: { errors: { message: string }[] | null } }>(
            CREATE_PAYMENT,
            { input },
          )
          const errors = data.createHrPayrollPayment.errors
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(isPaid ? '补发已登记' : '发放已登记,本单标记为已发放')
          refreshAll()
        }}
      />
    </div>
  )
}
