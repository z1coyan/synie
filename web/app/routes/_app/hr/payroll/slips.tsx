import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { MonthSelect, monthOptions, today } from './-shared'
import { PaymentsSection } from './-payments-section'

export const Route = createFileRoute('/_app/hr/payroll/slips')({
  component: PayrollSlipsPage,
})

const MONTH_STATS = `
  query ($month: String!) {
    hrPayrollMonthStats(month: $month)
  }
`
const GENERATE = `
  mutation ($input: GenerateHrPayrollsInput!) {
    generateHrPayrolls(input: $input)
  }
`
const CREATE_PAYROLL = `
  mutation ($input: CreateHrPayrollInput!) {
    createHrPayroll(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_PAYROLL = `
  mutation ($id: ID!, $input: UpdateHrPayrollInput!) {
    updateHrPayroll(id: $id, input: $input) { result { id } errors { message } }
  }
`
const REFRESH_PAYROLL = `
  mutation ($id: ID!) {
    refreshHrPayroll(id: $id) { result { id } errors { message } }
  }
`
const PAY_REMAINING = `
  mutation ($input: PayRemainingHrPayrollPaymentInput!) {
    payRemainingHrPayrollPayment(input: $input) { result { id } errors { message } }
  }
`

// 未发差额(以行数据估算,仅作展示;实发金额由后端锁内权威计算)
const remainingOf = (row: Row) => Number(row.payable || 0) - Number(row.paidTotal || 0)

interface MonthStats {
  count: number
  pendingCount: number
  payableTotal: string
  paidTotal: string
}

// 月份由页面月份选择器锁定(fixedFilter),不进表格;备注/时间戳进抽屉不占列宽
const GRID_COLUMNS = [
  'employeeId',
  'workdays',
  'attendanceDays',
  'missingDays',
  'overtimeHours',
  'dailyWage',
  'baseAmount',
  'allowance',
  'bonus',
  'fine',
  'loanDeduction',
  'payable',
  'paidTotal',
  'status',
]

const GRID_OVERRIDES = {
  status: { enumColors: { PENDING: 'warning', PAID: 'success' } },
  missingDays: {
    render: (v) => (Number(v) > 0 ? <span className="text-danger">{String(v)}</span> : String(v ?? 0)),
  },
} satisfies Record<string, ColumnOverride>

// 派生金额与状态只读展示(后端 writable? false,提交也不收)
const READONLY_FIELDS = {
  baseAmount: { edit: 'readOnly' as const },
  payable: { edit: 'readOnly' as const },
  paidTotal: { edit: 'readOnly' as const },
  status: { edit: 'readOnly' as const },
}

function PayrollSlipsPage() {
  const options = monthOptions()
  const [month, setMonth] = useState(options[0].value)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [payDialog, setPayDialog] = useState<Row[] | null>(null)
  const [paying, setPaying] = useState(false)
  const queryClient = useQueryClient()

  // 发放按 hr_payroll_payment 自身权限码门控(发放≠改单)
  const paymentsMeta = useGridMeta('hrPayrollPayments')
  const canPay = (paymentsMeta.data?.capabilities ?? []).includes('create')

  const stats = useQuery({
    queryKey: ['payrollMonthStats', month],
    queryFn: () => gqlFetch<{ hrPayrollMonthStats: string | MonthStats }>(MONTH_STATS, { month }),
    // generic action 的 map 经 GraphQL 是 json_string(照考勤月汇总先例)
    select: (d) =>
      (typeof d.hrPayrollMonthStats === 'string'
        ? JSON.parse(d.hrPayrollMonthStats)
        : d.hrPayrollMonthStats) as MonthStats,
  })

  // 发放/借款联动跨资源,一律广播失效(staleTime 下重挂不重取,必须显式失效)
  const invalidateAll = () => {
    for (const resource of ['hrPayrolls', 'hrPayrollPayments', 'hrEmployeeLoans']) {
      void queryClient.invalidateQueries({ queryKey: ['gridRows', resource] })
      void queryClient.invalidateQueries({ queryKey: ['rowById', resource] })
    }
    void queryClient.invalidateQueries({ queryKey: ['payrollMonthStats'] })
    void queryClient.invalidateQueries({ queryKey: ['loanBalances'] })
  }

  const generate = async () => {
    setGenerating(true)
    try {
      const data = await gqlFetch<{ generateHrPayrolls: string | { created: number; skipped: number } }>(
        GENERATE,
        { input: { month } },
      )
      const result = (
        typeof data.generateHrPayrolls === 'string' ? JSON.parse(data.generateHrPayrolls) : data.generateHrPayrolls
      ) as { created: number; skipped: number }
      toast.success(`已生成 ${result.created} 张工资单`, {
        description: result.skipped > 0 ? `${result.skipped} 张已存在,跳过不覆盖` : undefined,
      })
      invalidateAll()
    } catch (e) {
      toast.danger('生成失败', { description: (e as Error).message })
    } finally {
      setGenerating(false)
    }
  }

  // 一键发放:后端锁内按 应发−已发 计算金额,这里只挑差额>0 的行发起
  const runPay = async () => {
    const targets = (payDialog ?? []).filter((r) => remainingOf(r) > 0)
    setPaying(true)
    let done = 0
    const failures: string[] = []

    for (const row of targets) {
      try {
        const data = await gqlFetch<{
          payRemainingHrPayrollPayment: { errors: { message: string }[] | null }
        }>(PAY_REMAINING, { input: { payrollId: row.id, paidOn: today() } })
        const errors = data.payRemainingHrPayrollPayment.errors
        if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
        done += 1
      } catch (e) {
        failures.push((e as Error).message)
      }
    }

    setPaying(false)
    setPayDialog(null)
    if (done > 0) toast.success(`已发放 ${done} 张工资单`)
    if (failures.length > 0)
      toast.danger(`${failures.length} 张发放失败`, { description: failures[0] })
    invalidateAll()
  }

  const refresh = async (row: Row) => {
    try {
      const data = await gqlFetch<{ refreshHrPayroll: { errors: { message: string }[] | null } }>(
        REFRESH_PAYROLL,
        { id: row.id },
      )
      const errors = data.refreshHrPayroll.errors
      if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
      toast.success('已按当前考勤与员工档案重取快照')
      invalidateAll()
    } catch (e) {
      toast.danger('重取快照失败', { description: (e as Error).message })
    }
  }

  const s = stats.data

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <p className="text-sm text-ink-500">
          应发 = 月工日 × 日薪 + 补贴 + 奖金 − 罚款 − 借款抵扣;生成按考勤月汇总快照建单,已存在的不覆盖。
          待发放可改可删,已发放锁死,差错在抽屉里登记补发。
        </p>
        <div className="flex items-end gap-2">
          <MonthSelect value={month} onChange={setMonth} />
          <Button variant="primary" isDisabled={generating} onPress={() => void generate()}>
            {generating ? '生成中…' : '生成工资单'}
          </Button>
        </div>
      </div>

      {s && s.count > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          <span className="font-medium">{s.count} 张工资单</span>
          <span className={s.pendingCount > 0 ? 'text-warning' : ''}>未发放 {s.pendingCount} 张</span>
          <span>应发合计 {formatAmount(s.payableTotal)}</span>
          <span className="font-medium">实发合计 {formatAmount(s.paidTotal)}</span>
        </div>
      )}

      <div className="mt-4">
        <SynieDataGrid
          resource="hrPayrolls"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          fixedFilter={{ month: { eq: month } }}
          createLabel="手工建单"
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: row.status === 'PENDING' ? 'edit' : 'view', row })}
          rowActions={[
            // 发放按 hr_payroll_payment:create 门控,不能用本表 capability 字段(那是 hr.payroll 的码)
            ...(canPay
              ? [{ key: 'pay', label: '发放', onAction: (row: Row) => setPayDialog([row]) }]
              : []),
            {
              key: 'refresh',
              label: '重取快照',
              capability: 'update',
              onAction: (row) => void refresh(row),
            },
          ]}
          bulkActions={
            canPay
              ? [{ key: 'payRemaining', label: '批量发放', onAction: (rows) => setPayDialog(rows) }]
              : undefined
          }
          onMutated={invalidateAll}
        />
      </div>

      <SynieRecordDrawer
        {...drawerConfig('hrPayrolls')}
        resource="hrPayrolls"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d && d.row?.status === 'PENDING' ? { ...d, mode: 'edit' } : d))}
        contentClassName="w-full lg:w-[720px]"
        exclude={['createdById']}
        fields={{
          ...drawerConfig('hrPayrolls').fields,
          ...READONLY_FIELDS,
          // 员工与月份是单据身份,建单后不可改(错了删单重建)
          employeeId: { required: true, order: -2, cols: 6, edit: 'createOnly' },
          month: {
            required: true,
            order: -1,
            cols: 6,
            edit: 'createOnly',
            defaultValue: month,
            placeholder: 'YYYY-MM',
          },
        }}
        onSubmit={async (values, mode) => {
          // 手填快照字段照单收;派生金额(baseAmount/payable)后端重算,不提交
          const base = {
            workdays: values.workdays,
            attendanceDays: values.attendanceDays,
            missingDays: values.missingDays,
            overtimeHours: values.overtimeHours,
            dailyWage: values.dailyWage,
            allowance: values.allowance,
            bonus: values.bonus,
            fine: values.fine,
            loanDeduction: values.loanDeduction,
            remarks: values.remarks,
          }

          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createHrPayroll: { errors: { message: string }[] | null } }>(
              CREATE_PAYROLL,
              { input: { ...base, employeeId: values.employeeId, month: values.month } },
            )
            errors = data.createHrPayroll.errors
          } else {
            const data = await gqlFetch<{ updateHrPayroll: { errors: { message: string }[] | null } }>(
              UPDATE_PAYROLL,
              { id: drawer!.row!.id, input: base },
            )
            errors = data.updateHrPayroll.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '工资单已创建' : '工资单已更新,应发已重算')
          invalidateAll()
        }}
        extraContent={(mode, row) =>
          mode !== 'create' && row ? <PaymentsSection payroll={row} onChanged={invalidateAll} /> : null
        }
      />

      <AlertDialog.Backdrop isOpen={payDialog !== null} onOpenChange={(open) => !open && setPayDialog(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]" aria-label="确认发放">
            <AlertDialog.Header>
              <AlertDialog.Heading>确认发放?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {(() => {
                const rows = payDialog ?? []
                const targets = rows.filter((r) => remainingOf(r) > 0)
                const total = targets.reduce((acc, r) => acc + remainingOf(r), 0)
                const skipped = rows.length - targets.length

                return targets.length === 0 ? (
                  <p className="text-sm text-ink-500">所选工资单均无未发差额,无需发放。</p>
                ) : (
                  <p className="text-sm text-ink-500">
                    将按未发差额(应发 − 已发)发放 <span className="font-medium">{targets.length}</span> 张工资单,
                    合计 <span className="font-medium">{formatAmount(String(total))}</span>
                    {skipped > 0 ? `;${skipped} 张已发放完毕,自动跳过` : ''}。发放日期取今天,金额以后端实时核算为准。
                  </p>
                )
              })()}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={paying}>
                取消
              </Button>
              <Button
                variant="primary"
                isPending={paying}
                isDisabled={(payDialog ?? []).every((r) => remainingOf(r) <= 0)}
                onPress={() => void runPay()}
              >
                发放
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
