import { useState } from 'react'
import { AlertDialog, Button, Calendar, DateField, DatePicker, Input, Label, NumberField, TextField, toast } from '@heroui/react'
import { parseDate } from '@internationalized/date'
import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { gqlEnum } from '~/components/synie-data-grid/query'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'

const DESTROY_RECONCILIATION = `
  mutation ($id: ID!) {
    destroyAccBankReconciliation(id: $id) { errors { message } }
  }
`

// 银行账户绑定科目:严格对账的前提,未绑定时隐藏表单并引导去绑定
const BANK_ACCOUNT_LEDGER = `
  query ($id: ID!) {
    accBankAccounts(filter: {id: {eq: $id}}, limit: 1, offset: 0) { results { id accountId } }
  }
`

const REMAINING = `
  query ($txnId: ID!, $journalId: ID!) {
    accBankReconciliationRemaining(bankTransactionId: $txnId, journalId: $journalId)
  }
`
const CREATE_RECONCILIATION = `
  mutation ($input: CreateAccBankReconciliationInput!) {
    createAccBankReconciliation(input: $input) { result { id } errors { message } }
  }
`
const QUICK_CREATE = `
  mutation ($input: QuickCreateAccBankReconciliationInput!) {
    quickCreateAccBankReconciliation(input: $input) { result { id } errors { message } }
  }
`

export interface ReconcileDrawerProps {
  txn: Row | null
  onOpenChange: (open: boolean) => void
  /** 任一对账变更后回调(父列表刷新) */
  onChanged: () => void
}

export function ReconcileDrawer({ txn, onOpenChange, onChanged }: ReconcileDrawerProps) {
  // 对账增删后 bump:key 变化整体重挂,概要派生列与关联列表一起刷新
  const [version, setVersion] = useState(0)

  const bump = () => {
    setVersion((v) => v + 1)
    onChanged()
  }

  return (
    <SynieRecordDrawer
      key={`${txn?.id ?? ''}:${version}`}
      resource="accBankTransactions"
      label="流水对账"
      mode="view"
      isOpen={txn !== null}
      onOpenChange={onOpenChange}
      // 行数据来自列表白名单不全,按 id 自查完整记录(含派生列)
      rowId={txn?.id}
      contentClassName="w-full lg:w-[880px]"
      exclude={['balance', 'counterpartyAccount', 'note', 'insertedAt', 'updatedAt']}
      extraContent={(_mode, row) => (row ? <ReconcileSection txn={row} onChanged={bump} /> : null)}
    />
  )
}

function ReconcileSection({ txn, onChanged }: { txn: Row; onChanged: () => void }) {
  const [unlink, setUnlink] = useState<Row | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const ledger = useQuery({
    queryKey: ['bankAccountLedger', txn.bankAccountId],
    queryFn: () =>
      gqlFetch<{ accBankAccounts: { results: { id: string; accountId: string | null }[] } }>(
        BANK_ACCOUNT_LEDGER,
        { id: txn.bankAccountId }
      ).then((d) => d.accBankAccounts.results[0]?.accountId ?? null),
  })

  const confirmUnlink = async () => {
    if (!unlink) return
    setUnlinking(true)
    try {
      const data = await gqlFetch<{
        destroyAccBankReconciliation: { errors: { message: string }[] | null }
      }>(DESTROY_RECONCILIATION, { id: unlink.id })
      if (data.destroyAccBankReconciliation.errors?.length) {
        throw new Error(data.destroyAccBankReconciliation.errors.map((e) => e.message).join('; '))
      }
      toast.success('已解除对账')
      setUnlink(null)
      onChanged()
    } catch (e) {
      toast.danger('解除失败', { description: (e as Error).message })
    } finally {
      setUnlinking(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">对账关联记录</h3>
        <SynieDataGrid
          resource="accBankReconciliations"
          columns={['journalId', 'amount', 'insertedAt']}
          fixedFilter={{ bankTransactionId: { eq: txn.id } }}
          rowActions={[
            { key: 'unlink', label: '解除', isDanger: true, onAction: (row) => setUnlink(row) },
          ]}
        />
      </section>

      {ledger.data === null && !ledger.isPending && (
        <p className="text-sm text-danger">该银行账户未绑定会计科目,请先在「银行账户」中绑定后再对账。</p>
      )}
      {ledger.isError && (
        <p className="text-sm text-danger">银行账户信息加载失败:{(ledger.error as Error).message}</p>
      )}
      {typeof ledger.data === 'string' && (
        <>
          <LinkExistingForm txn={txn} ledgerAccountId={ledger.data} onChanged={onChanged} />
          <QuickCreateForm txn={txn} onChanged={onChanged} />
        </>
      )}

      <AlertDialog.Backdrop isOpen={unlink !== null} onOpenChange={(open) => !open && setUnlink(null)}>
        <AlertDialog.Container>
          {/* 退场动画期间 unlink 已清空,显式 aria-label 防 RAC 无标题警告 */}
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="确认解除对账">
            {unlink && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>确认解除对账?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>将解除该流水与凭证的对账关联(金额 {String(unlink.amount)}),此操作不影响凭证本身。</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={unlinking}>取消</Button>
                  <Button variant="danger" isPending={unlinking} onPress={confirmUnlink}>解除</Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}

/** 关联已有凭证:弹窗挑「同公司+已审核+含银行科目方向行」的凭证,选中即预填剩余可对账额度 */
function LinkExistingForm({
  txn,
  ledgerAccountId,
  onChanged,
}: {
  txn: Row
  ledgerAccountId: string
  onChanged: () => void
}) {
  const [journalId, setJournalId] = useState<string | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const side = txn.income != null ? 'debit' : 'credit'

  const pickJournal = async (id: string | null) => {
    setJournalId(id)
    setAmount(null)
    if (!id) return
    try {
      const d = await gqlFetch<{ accBankReconciliationRemaining: string }>(REMAINING, {
        txnId: txn.id,
        journalId: id,
      })
      setAmount(Number(d.accBankReconciliationRemaining))
    } catch (e) {
      toast.danger('剩余额度查询失败', { description: (e as Error).message })
    }
  }

  const submit = async () => {
    if (!journalId || amount == null) return
    setSubmitting(true)
    try {
      const data = await gqlFetch<{
        createAccBankReconciliation: { errors: { message: string }[] | null }
      }>(CREATE_RECONCILIATION, {
        input: { bankTransactionId: txn.id, journalId, amount: String(amount) },
      })
      if (data.createAccBankReconciliation.errors?.length) {
        throw new Error(data.createAccBankReconciliation.errors.map((e) => e.message).join('; '))
      }
      toast.success('已关联凭证')
      onChanged()
    } catch (e) {
      toast.danger('关联失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">关联已有凭证</h3>
      <div className="grid items-end gap-3 lg:grid-cols-[1fr_200px_auto]">
        <RemoteDialogSelect
          resource="accGlJournals"
          label="凭证"
          // 直连资源须显式给显示字段(缺省 name 拼出非法查询)
          labelField="voucherNo"
          searchFields={['voucherNo']}
          placeholder="选择已审核凭证…"
          value={journalId}
          onChange={(id) => void pickJournal(id)}
          gridColumns={['voucherNo', 'date', 'postingDate', 'remarks', 'debitTotal', 'creditTotal']}
          gridFilter={{
            companyId: { eq: txn.companyId },
            status: { eq: gqlEnum('AUDITED') },
            // 方向匹配预筛:凭证须含该银行科目对应方向的行(后端校验兜底)
            lines: { accountId: { eq: ledgerAccountId }, [side]: { greaterThan: '0' } },
          }}
        />
        <NumberField
          fullWidth
          value={amount == null ? NaN : amount}
          onChange={(n) => setAmount(Number.isFinite(n) ? n : null)}
        >
          <Label>对账金额</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="选凭证后自动预填" />
          </NumberField.Group>
        </NumberField>
        <Button
          isDisabled={!journalId || amount == null || amount <= 0}
          isPending={submitting}
          onPress={submit}
        >
          关联
        </Button>
      </div>
    </section>
  )
}

/** 快速新增凭证并关联:银行方向行系统预填,用户只选对方科目;创建后自动审核+关联,整体事务 */
function QuickCreateForm({ txn, onChanged }: { txn: Row; onChanged: () => void }) {
  // 三码门控:reconcile(能进本抽屉即有)+ 凭证 create/audit 能力
  const journalMeta = useGridMeta('accGlJournals')
  const isIncome = txn.income != null
  const [accountId, setAccountId] = useState<string | null>(null)
  const [amount, setAmount] = useState<number | null>(() => {
    const n = Number(txn.unreconciledAmount)
    return Number.isFinite(n) && n > 0 ? n : null
  })
  const [summary, setSummary] = useState<string>((txn.summary as string | null) ?? '')
  // 凭证/过账日期默认取流水交易日(UTC 日期部分,与流水展示同口径)
  const [postingDate, setPostingDate] = useState<string | null>(String(txn.occurredAt).slice(0, 10))
  const [submitting, setSubmitting] = useState(false)

  const canQuick = ['create', 'audit'].every((c) =>
    (journalMeta.data?.capabilities ?? []).includes(c)
  )
  if (!canQuick) return null

  const submit = async () => {
    if (!accountId || amount == null || !postingDate) return
    setSubmitting(true)
    try {
      const data = await gqlFetch<{
        quickCreateAccBankReconciliation: { errors: { message: string }[] | null }
      }>(QUICK_CREATE, {
        input: {
          bankTransactionId: txn.id,
          counterAccountId: accountId,
          amount: String(amount),
          summary: summary || null,
          postingDate,
        },
      })
      if (data.quickCreateAccBankReconciliation.errors?.length) {
        throw new Error(
          data.quickCreateAccBankReconciliation.errors.map((e) => e.message).join('; ')
        )
      }
      toast.success('凭证已创建并完成对账')
      onChanged()
    } catch (e) {
      toast.danger('快速对账失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">快速新增凭证并关联</h3>
      <p className="text-xs text-muted">
        {isIncome ? '借:银行科目(系统预填) 贷:所选科目' : '借:所选科目 贷:银行科目(系统预填)'}
        ,保存后自动审核过账并建立对账关联。
      </p>
      <div className="grid items-end gap-3 lg:grid-cols-[1fr_160px_1fr_180px_auto]">
        <RemoteSelect
          resource="basAccounts"
          label={isIncome ? '贷方科目' : '借方科目'}
          labelField="name"
          searchFields={['code', 'name']}
          placeholder="选择对方科目…"
          value={accountId}
          onChange={(id) => setAccountId(id)}
          filter={`{companyId: {eq: ${JSON.stringify(txn.companyId)}}, isGroup: {eq: false}, active: {eq: true}}`}
        />
        <NumberField
          fullWidth
          value={amount == null ? NaN : amount}
          onChange={(n) => setAmount(Number.isFinite(n) ? n : null)}
        >
          <Label>金额</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="默认未对账余额" />
          </NumberField.Group>
        </NumberField>
        <TextField fullWidth value={summary} onChange={setSummary}>
          <Label>摘要</Label>
          <Input placeholder="默认取流水摘要" />
        </TextField>
        <DatePicker
          value={postingDate ? safeParseDate(postingDate) : null}
          onChange={(v) => setPostingDate(v ? v.toString() : null)}
        >
          <Label>凭证/过账日期</Label>
          <DateField.Group fullWidth>
            <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
            <DateField.Suffix>
              <DatePicker.Trigger>
                <DatePicker.TriggerIndicator />
              </DatePicker.Trigger>
            </DateField.Suffix>
          </DateField.Group>
          <DatePicker.Popover>
            <Calendar aria-label="凭证/过账日期">
              <Calendar.Header>
                <Calendar.YearPickerTrigger>
                  <Calendar.YearPickerTriggerHeading />
                  <Calendar.YearPickerTriggerIndicator />
                </Calendar.YearPickerTrigger>
                <Calendar.NavButton slot="previous" />
                <Calendar.NavButton slot="next" />
              </Calendar.Header>
              <Calendar.Grid>
                <Calendar.GridHeader>{(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}</Calendar.GridHeader>
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
        <Button
          isDisabled={!accountId || amount == null || amount <= 0 || !postingDate}
          isPending={submitting}
          onPress={submit}
        >
          创建并对账
        </Button>
      </div>
    </section>
  )
}

// 非法日期串回落 null,不让抽屉崩掉
function safeParseDate(v: string) {
  try {
    return parseDate(v)
  } catch {
    return null
  }
}
