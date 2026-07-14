import { useEffect, useState } from 'react'
import { Alert, AlertDialog, Button, Calendar, Chip, DateField, DatePicker, Input, Label, Meter, Modal, NumberField, Surface, TextField, toast } from '@heroui/react'
import { parseDate } from '@internationalized/date'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatAmount } from '~/lib/amount'
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
  const queryClient = useQueryClient()

  // 对账增删后显式失效相关查询(全局 staleTime 30s,重挂并不保证重取):
  // 概要卡/字段读的 rowById + 关联记录列表;父流水列表由页面 onChanged 自行失效
  const bump = () => {
    if (txn) queryClient.invalidateQueries({ queryKey: ['rowById', 'accBankTransactions', txn.id] })
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBankReconciliations'] })
    onChanged()
  }

  return (
    <SynieRecordDrawer
      key={txn?.id ?? ''}
      resource="accBankTransactions"
      label="流水对账"
      mode="view"
      isOpen={txn !== null}
      onOpenChange={onOpenChange}
      // 行数据来自列表白名单不全,按 id 自查完整记录(含派生列)
      rowId={txn?.id}
      contentClassName="w-full lg:w-[880px]"
      // 金额/状态/进度/交易时间都进头部概要卡;银行余额快照与系统时间戳对对账无用
      exclude={[
        'income',
        'expense',
        'occurredAt',
        'reconcileStatus',
        'reconciledAmount',
        'unreconciledAmount',
        'balance',
        'insertedAt',
        'updatedAt',
      ]}
      // 剩余字段只是辨识流水用的次要信息,双列紧凑排布
      fields={{
        companyId: { order: 0, cols: 6 },
        bankAccountId: { order: 1, cols: 6 },
        counterpartyName: { order: 2, cols: 6 },
        counterpartyAccount: { order: 3, cols: 6 },
        summary: { order: 4, cols: 6 },
        note: { order: 5, cols: 6 },
      }}
      headerContent={(_mode, row) => (row ? <TxnSummary txn={row} /> : null)}
      extraContent={(_mode, row) => (row ? <ReconcileSection txn={row} onChanged={bump} /> : null)}
    />
  )
}

const STATUS_COLORS: Record<string, 'danger' | 'warning' | 'success'> = {
  UNRECONCILED: 'danger',
  PARTIAL: 'warning',
  RECONCILED: 'success',
}

/** 头部概要卡:大字金额 + 对账状态与进度条,用户不再从平铺字段里找数、心算差额 */
function TxnSummary({ txn }: { txn: Row }) {
  // 状态中文名取 GridMeta 枚举标签(抽屉已查过,恒缓存命中),不另行硬编码
  const meta = useGridMeta('accBankTransactions')
  const isIncome = txn.income != null
  const amount = Number(isIncome ? txn.income : txn.expense) || 0
  const reconciled = Number(txn.reconciledAmount) || 0
  const unreconciled = Number(txn.unreconciledAmount) || 0
  const status = String(txn.reconcileStatus ?? 'UNRECONCILED')
  const statusLabel =
    meta.data?.columns
      .find((c) => c.name === 'reconcileStatus')
      ?.enumOptions?.find((o) => o.value === status)?.label ?? status
  const statusColor = STATUS_COLORS[status] ?? 'default'

  return (
    <Surface variant="secondary" className="flex flex-col gap-5 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">{isIncome ? '收入金额' : '支出金额'}</span>
          {/* 方向已由 label 说明,不再加正负号(「支出金额 -x」是双重否定);收入以绿色强调 */}
          <div
            className={`text-3xl font-semibold leading-none tabular-nums ${isIncome ? 'text-success' : 'text-foreground'}`}
          >
            {formatAmount(amount)}
          </div>
          <span className="mt-1 text-sm text-muted">
            {new Date(String(txn.occurredAt)).toLocaleString('zh-CN', { hour12: false })}
          </span>
        </div>
        <Chip size="sm" color={statusColor}>
          {statusLabel}
        </Chip>
      </div>
      <div className="flex flex-col gap-2">
        <Meter aria-label="对账进度" value={reconciled} maxValue={amount || 1} color={statusColor}>
          <Label>对账进度</Label>
          <Meter.Output />
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
        <div className="flex items-center justify-between text-sm tabular-nums">
          <span className="text-muted">
            已对账 <span className="font-medium text-foreground">{formatAmount(reconciled)}</span>
          </span>
          <span className="text-muted">
            未对账 <span className="font-medium text-foreground">{formatAmount(unreconciled)}</span>
          </span>
        </div>
      </div>
    </Surface>
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

  // 还有未对账余额时把动作按钮升为主按钮引导操作;已对完则全部退居次要
  const hasRemaining = Number(txn.unreconciledAmount) > 0

  return (
    <div className="flex flex-col gap-4">
      {ledger.data === null && !ledger.isPending && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>该银行账户未绑定会计科目</Alert.Title>
            <Alert.Description>请先在「银行账户」中绑定科目,再进行对账。</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {ledger.isError && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>银行账户信息加载失败</Alert.Title>
            <Alert.Description>{(ledger.error as Error).message}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          {/* 与字段栅格的 label 同一套样式(ViewField:text-sm text-muted) */}
          <h3 className="text-sm text-muted">对账记录</h3>
          {typeof ledger.data === 'string' && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onPress={() => setLinkOpen(true)}>
                关联已有凭证
              </Button>
              {canQuick && (
                <Button
                  size="sm"
                  variant={hasRemaining ? 'primary' : 'secondary'}
                  onPress={() => setQuickOpen(true)}
                >
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
          // 抽屉内嵌短列表,搜索框只添噪音
          hideSearch
          overrides={{
            amount: { render: (v) => formatAmount(v) },
            insertedAt: { label: '对账时间' },
          }}
          // accBankReconciliations 无独立权限码、capabilities 恒空;入口已由外层「对账」行动作按
          // reconcile 门控(能进本抽屉即有 reconcile),故此处解除动作不再挂 capability
          rowActions={[
            { key: 'unlink', label: '解除', isDanger: true, onAction: (row) => setUnlink(row) },
          ]}
        />
      </section>

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
                  <p>将解除该流水与凭证的对账关联(金额 {formatAmount(unlink.amount)}),此操作不影响凭证本身。</p>
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
