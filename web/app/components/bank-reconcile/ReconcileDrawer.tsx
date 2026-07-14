import { useEffect, useState } from 'react'
import { AlertDialog, Button, Calendar, DateField, DatePicker, Input, Label, Modal, NumberField, TextField, toast } from '@heroui/react'
import { parseDate } from '@internationalized/date'
import { useQuery } from '@tanstack/react-query'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { gqlEnum } from '~/components/synie-data-grid/query'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'

const DESTROY_RECONCILIATION = `
  mutation ($id: ID!) {
    destroyAccBankReconciliation(id: $id) { errors { message } }
  }
`

// 银行账户绑定科目:严格对账的前提,未绑定时隐藏操作按钮并引导去绑定
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
  const [linkOpen, setLinkOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)

  const ledger = useQuery({
    queryKey: ['bankAccountLedger', txn.bankAccountId],
    queryFn: () =>
      gqlFetch<{ accBankAccounts: { results: { id: string; accountId: string | null }[] } }>(
        BANK_ACCOUNT_LEDGER,
        { id: txn.bankAccountId }
      ).then((d) => d.accBankAccounts.results[0]?.accountId ?? null),
  })

  // 快速新增凭证的三码门控:reconcile(能进本抽屉即有)+ 凭证 create/audit 能力
  const journalMeta = useGridMeta('accGlJournals')
  const canQuick = ['create', 'audit'].every((c) =>
    (journalMeta.data?.capabilities ?? []).includes(c)
  )

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
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">对账关联记录</h3>
          {typeof ledger.data === 'string' && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onPress={() => setLinkOpen(true)}>
                关联已有凭证
              </Button>
              {canQuick && (
                <Button size="sm" variant="secondary" onPress={() => setQuickOpen(true)}>
                  快速新增凭证
                </Button>
              )}
            </div>
          )}
        </div>
        <SynieDataGrid
          resource="accBankReconciliations"
          columns={['journalId', 'amount', 'insertedAt']}
          fixedFilter={{ bankTransactionId: { eq: txn.id } }}
          // accBankReconciliations 无独立权限码、capabilities 恒空;入口已由外层「对账」行动作按
          // reconcile 门控(能进本抽屉即有 reconcile),故此处解除动作不再挂 capability
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
          <LinkJournalModal
            isOpen={linkOpen}
            onOpenChange={setLinkOpen}
            txn={txn}
            ledgerAccountId={ledger.data}
            onChanged={onChanged}
          />
          {canQuick && (
            <QuickCreateModal
              isOpen={quickOpen}
              onOpenChange={setQuickOpen}
              txn={txn}
              onChanged={onChanged}
            />
          )}
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

/** 关联已有凭证:弹窗内直接挑「同公司+已审核+含银行科目方向行」的凭证,选中即预填剩余可对账额度 */
function LinkJournalModal({
  isOpen,
  onOpenChange,
  txn,
  ledgerAccountId,
  onChanged,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  txn: Row
  ledgerAccountId: string
  onChanged: () => void
}) {
  const [picked, setPicked] = useState<Row[]>([])
  const [amount, setAmount] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const side = txn.income != null ? 'debit' : 'credit'
  const journal = picked[0] ?? null

  // 关闭即清草稿,再次打开从空白开始
  const handleOpenChange = (open: boolean) => {
    onOpenChange(open)
    if (!open) {
      setPicked([])
      setAmount(null)
    }
  }

  const handlePick = async (rows: Row[]) => {
    setPicked(rows)
    setAmount(null)
    const id = rows[0]?.id
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
    if (!journal || amount == null) return
    setSubmitting(true)
    try {
      const data = await gqlFetch<{
        createAccBankReconciliation: { errors: { message: string }[] | null }
      }>(CREATE_RECONCILIATION, {
        input: { bankTransactionId: txn.id, journalId: journal.id, amount: String(amount) },
      })
      if (data.createAccBankReconciliation.errors?.length) {
        throw new Error(data.createAccBankReconciliation.errors.map((e) => e.message).join('; '))
      }
      toast.success('已关联凭证')
      handleOpenChange(false)
      onChanged()
    } catch (e) {
      toast.danger('关联失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="max-w-4xl">
          <Modal.Header>
            <Modal.Heading>关联已有凭证</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <SynieDataGrid
              resource="accGlJournals"
              columns={['voucherNo', 'date', 'postingDate', 'remarks', 'debitTotal', 'creditTotal']}
              fixedFilter={{
                companyId: { eq: txn.companyId },
                status: { eq: gqlEnum('AUDITED') },
                // 方向匹配预筛:凭证须含该银行科目对应方向的行(后端校验兜底)
                lines: { accountId: { eq: ledgerAccountId }, [side]: { greaterThan: '0' } },
              }}
              pick="single"
              pickedRows={picked}
              onPickChange={(rows) => void handlePick(rows)}
            />
          </Modal.Body>
          <Modal.Footer>
            <span className="mr-auto text-sm text-muted">
              已选:{journal ? String(journal.voucherNo) : '未选择'}
            </span>
            <NumberField
              className="w-48"
              value={amount == null ? NaN : amount}
              onChange={(n) => setAmount(Number.isFinite(n) ? n : null)}
            >
              <Label>对账金额</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input placeholder="选凭证后自动预填" />
              </NumberField.Group>
            </NumberField>
            <Button variant="secondary" onPress={() => handleOpenChange(false)} isDisabled={submitting}>
              取消
            </Button>
            <Button
              isDisabled={!journal || amount == null || amount <= 0}
              isPending={submitting}
              onPress={submit}
            >
              关联
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

/** 快速新增凭证并关联:银行方向行系统预填,用户只选对方科目;创建后自动审核+关联,整体事务 */
function QuickCreateModal({
  isOpen,
  onOpenChange,
  txn,
  onChanged,
}: {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  txn: Row
  onChanged: () => void
}) {
  const isIncome = txn.income != null
  const [accountId, setAccountId] = useState<string | null>(null)
  const [amount, setAmount] = useState<number | null>(() => {
    const n = Number(txn.unreconciledAmount)
    return Number.isFinite(n) && n > 0 ? n : null
  })
  // 抽屉重挂时 rowById 可能先回缓存旧行,refetch 落地后同步默认金额,避免残留旧余额
  const unreconciled = Number(txn.unreconciledAmount)
  useEffect(() => {
    setAmount(Number.isFinite(unreconciled) && unreconciled > 0 ? unreconciled : null)
  }, [unreconciled])
  const [summary, setSummary] = useState<string>((txn.summary as string | null) ?? '')
  // 凭证/过账日期默认取流水交易日(UTC 日期部分,与流水展示同口径)
  const [postingDate, setPostingDate] = useState<string | null>(String(txn.occurredAt).slice(0, 10))
  const [submitting, setSubmitting] = useState(false)

  // 关闭即清对方科目(金额/摘要/日期保留默认值,再开无需重填)
  const handleOpenChange = (open: boolean) => {
    onOpenChange(open)
    if (!open) setAccountId(null)
  }

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
      handleOpenChange(false)
      onChanged()
    } catch (e) {
      toast.danger('快速对账失败', { description: (e as Error).message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Container>
        <Modal.Dialog className="max-w-lg">
          <Modal.Header>
            <Modal.Heading>快速新增凭证并关联</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <p className="text-xs text-muted">
                {isIncome ? '借:银行科目(系统预填) 贷:所选科目' : '借:所选科目 贷:银行科目(系统预填)'}
                ,保存后自动审核过账并建立对账关联。
              </p>
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
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => handleOpenChange(false)} isDisabled={submitting}>
              取消
            </Button>
            <Button
              isDisabled={!accountId || amount == null || amount <= 0 || !postingDate}
              isPending={submitting}
              onPress={submit}
            >
              创建并对账
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
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
