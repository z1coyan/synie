import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertDialog,
  Button,
  Calendar,
  DateField,
  DatePicker,
  Label,
  toast,
} from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import {
  AcceptanceTransactionDrawer,
  safeParseDate,
  type TransactionDrawerState,
} from './-transaction-drawer'

export const Route = createFileRoute('/_app/finance/acceptance/transactions')({
  component: BillTransactionsPage,
})

const AUDIT_BILL_TRANSACTION = `
  mutation ($id: ID!, $input: AuditAccBillTransactionInput!) {
    auditAccBillTransaction(id: $id, input: $input) { result { id } errors { message } }
  }
`

const GRID_COLUMNS = [
  'docNo',
  'companyId',
  'transactionType',
  'billId',
  'amount',
  'occurredOn',
  'partyId',
  'discountOrg',
  'status',
  'auditedById',
]

// 状态胶囊配色:草稿灰、已审核绿、已作废红
const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
  amount: { render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>

function BillTransactionsPage() {
  const [drawer, setDrawer] = useState<TransactionDrawerState | null>(null)
  const queryClient = useQueryClient()

  // 两视图同页联动:审核/作废驱动持有重放,接收顺带建档票据——写后统一显式失效兄弟缓存,
  // 免得切 tab 撞上 staleTime 内的陈旧缓存(重挂不重取)
  const invalidateSiblings = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillHoldings'] })
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBills'] })
  }
  const invalidateAcceptance = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillTransactions'] })
    invalidateSiblings()
  }

  // 审核过账确认框(非调拨,需过账日期)
  const [auditDialog, setAuditDialog] = useState<{ id: string } | null>(null)
  const [auditDate, setAuditDate] = useState<string | null>(null)
  const [auditing, setAuditing] = useState(false)

  // 调拨审核确认框(不生凭证,仅变动持有库存,不收过账日期)
  const [reallocateAuditDialog, setReallocateAuditDialog] = useState<{ id: string } | null>(null)
  const [reallocateAuditing, setReallocateAuditing] = useState(false)

  const openAudit = (row: Row) => {
    if (row.transactionType === 'REALLOCATE') {
      setReallocateAuditDialog({ id: row.id })
      return
    }
    setAuditDate((row.postingDate as string | null) ?? (row.occurredOn as string | null) ?? null)
    setAuditDialog({ id: row.id })
  }

  const confirmAudit = async () => {
    if (!auditDialog || !auditDate) return
    setAuditing(true)
    try {
      const data = await gqlFetch<{ auditAccBillTransaction: { errors: { message: string }[] | null } }>(
        AUDIT_BILL_TRANSACTION,
        { id: auditDialog.id, input: { postingDate: auditDate } }
      )
      if (data.auditAccBillTransaction.errors && data.auditAccBillTransaction.errors.length > 0) {
        throw new Error(data.auditAccBillTransaction.errors.map((e) => e.message).join('; '))
      }
      toast.success('承兑交易已审核过账')
      setAuditDialog(null)
      invalidateAcceptance()
    } catch (e) {
      toast.danger('审核失败', { description: (e as Error).message })
    } finally {
      setAuditing(false)
    }
  }

  const confirmReallocateAudit = async () => {
    if (!reallocateAuditDialog) return
    setReallocateAuditing(true)
    try {
      const data = await gqlFetch<{ auditAccBillTransaction: { errors: { message: string }[] | null } }>(
        AUDIT_BILL_TRANSACTION,
        { id: reallocateAuditDialog.id, input: {} }
      )
      if (data.auditAccBillTransaction.errors && data.auditAccBillTransaction.errors.length > 0) {
        throw new Error(data.auditAccBillTransaction.errors.map((e) => e.message).join('; '))
      }
      toast.success('调拨已审核')
      setReallocateAuditDialog(null)
      invalidateAcceptance()
    } catch (e) {
      toast.danger('审核失败', { description: (e as Error).message })
    } finally {
      setReallocateAuditing(false)
    }
  }

  return (
    <>
      <p className="text-sm text-ink-500">
        承兑票据业务流水:接收在本页新增,转让、兑付、贴现、调拨从「持有承兑」的票据段行内发起;
        草稿态可自由编辑,审核后过账并驱动持有库存重放。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="accBillTransactions"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'occurredOn', direction: 'descending' }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          // 其余交易类型都基于已有承兑(从持有段行发起),唯一的凭空创建入口就是接收
          onCreate={() => setDrawer({ mode: 'create', txType: 'RECEIVE' })}
          createLabel="新增承兑接收"
          onEdit={(row) => setDrawer({ mode: row.status === 'DRAFT' ? 'edit' : 'view', row })}
          actionHandlers={{ audit: (rows) => openAudit(rows[0]!) }}
          // 作废走内建确认流程(refetch 只刷本表),持有/票据靠 onMutated 联动失效
          onMutated={invalidateSiblings}
        />
      </div>

      <AcceptanceTransactionDrawer state={drawer} onStateChange={setDrawer} onMutated={invalidateAcceptance} />

      <AlertDialog.Backdrop isOpen={auditDialog !== null} onOpenChange={(open) => !open && setAuditDialog(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="审核过账">
            {auditDialog && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>审核过账</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p className="mb-3">确认后交易将审核并生成总账分录,同时重放该票据的持有库存。</p>
                  <DatePicker value={safeParseDate(auditDate)} onChange={(v) => setAuditDate(v ? v.toString() : null)}>
                    <Label>过账日期</Label>
                    <DateField.Group fullWidth>
                      <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
                      <DateField.Suffix>
                        <DatePicker.Trigger>
                          <DatePicker.TriggerIndicator />
                        </DatePicker.Trigger>
                      </DateField.Suffix>
                    </DateField.Group>
                    <DatePicker.Popover>
                      <Calendar aria-label="过账日期">
                        <Calendar.Header>
                          <Calendar.YearPickerTrigger>
                            <Calendar.YearPickerTriggerHeading />
                            <Calendar.YearPickerTriggerIndicator />
                          </Calendar.YearPickerTrigger>
                          <Calendar.NavButton slot="previous" />
                          <Calendar.NavButton slot="next" />
                        </Calendar.Header>
                        <Calendar.Grid>
                          <Calendar.GridHeader>
                            {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
                          </Calendar.GridHeader>
                          <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
                        </Calendar.Grid>
                        <Calendar.YearPickerGrid>
                          <Calendar.YearPickerGridBody>
                            {({ year }) => <Calendar.YearPickerCell year={year} />}
                          </Calendar.YearPickerGridBody>
                        </Calendar.YearPickerGrid>
                      </Calendar>
                    </DatePicker.Popover>
                  </DatePicker>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={auditing}>
                    取消
                  </Button>
                  <Button isPending={auditing} isDisabled={!auditDate} onPress={confirmAudit}>
                    审核过账
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop
        isOpen={reallocateAuditDialog !== null}
        onOpenChange={(open) => !open && setReallocateAuditDialog(null)}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" aria-label="调拨审核">
            {reallocateAuditDialog && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>调拨审核</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>调拨审核仅变动持有库存,不生成凭证,确认?</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={reallocateAuditing}>
                    取消
                  </Button>
                  <Button isPending={reallocateAuditing} onPress={confirmReallocateAudit}>
                    确认
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
