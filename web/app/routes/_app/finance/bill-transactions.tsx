import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { parseDate } from '@internationalized/date'
import {
  AlertDialog,
  Button,
  Calendar,
  ComboBox,
  DateField,
  DatePicker,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Switch,
  TextField,
  toast,
} from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { BANKS } from '~/lib/banks'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { FkLink } from '~/components/synie-record-drawer/fk-preview'
import type { DrawerMode, FieldInputProps } from '~/components/synie-record-drawer/fields'
import type { GridColumnMeta, Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/bill-transactions')({
  component: BillTransactionsPage,
})

const CREATE_BILL_TRANSACTION = `
  mutation ($input: CreateAccBillTransactionInput!) {
    createAccBillTransaction(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_BILL_TRANSACTION = `
  mutation ($id: ID!, $input: UpdateAccBillTransactionInput!) {
    updateAccBillTransaction(id: $id, input: $input) { result { id } errors { message } }
  }
`
const AUDIT_BILL_TRANSACTION = `
  mutation ($id: ID!, $input: AuditAccBillTransactionInput!) {
    auditAccBillTransaction(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 票号查档:命中已建档票据(接收票面区,详见 ReceiveBillSection)
const LOOKUP_BILL = `
  query ($billNo: String!) {
    accBills(filter: {billNo: {eq: $billNo}}, limit: 1, offset: 0) {
      results { id billNo billKind dueDate faceAmount acceptorName }
    }
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

// 详情/表单不展示:状态与审核元数据由审核动作单独维护;插入/更新时间戳照系统字段惯例
const EXCLUDE = ['status', 'auditedAt', 'auditedById', 'createdById', 'postingDate', 'insertedAt', 'updatedAt']

// 交易类型显隐辅助:传入的任一类型命中当前 transactionType 即为 true
const T = (...types: string[]) => (v: Record<string, unknown>) => types.includes(String(v.transactionType))

// 对手候选数据源按 partyType 切换,与增值税发票 partyId 同一套 PartyType(供应商/客户/内部公司)
const PARTY_SOURCE: Record<string, [resource: string, label: string]> = {
  SUPPLIER: ['purSuppliers', '供应商'],
  CUSTOMER: ['salCustomers', '客户'],
  COMPANY: ['basCompanies', '内部公司'],
}

// 交易类型选项:值=GraphQL 大写 token,标签=后端枚举 description(BILL_KIND_OPTIONS 同款先例)。
// 不用 meta 默认 Select 而自定义 input,是为了在 onChange 里同步重置页面态(不能放 effects:
// effects 在 setValues updater 内执行,React updater 必须纯,内里 setState 会 dev 警告 + StrictMode 双跑)
const TRANSACTION_TYPE_OPTIONS = [
  { value: 'RECEIVE', label: '接收' },
  { value: 'ENDORSE', label: '转让' },
  { value: 'SETTLE', label: '兑付' },
  { value: 'DISCOUNT', label: '贴现' },
  { value: 'REALLOCATE', label: '调拨' },
]

const BILL_KIND_OPTIONS = [
  { value: 'BANK_ACCEPTANCE', label: '银行承兑汇票' },
  { value: 'COMMERCIAL_ACCEPTANCE', label: '商业承兑汇票' },
  { value: 'FINANCE_COMPANY_ACCEPTANCE', label: '财务公司承兑汇票' },
]
const BILL_KIND_LABELS: Record<string, string> = Object.fromEntries(BILL_KIND_OPTIONS.map((o) => [o.value, o.label]))

/** 子票止 = 子票起 + 金额×100 − 1(分为最小单位);任一端缺失回 null */
function recalcSeg(v: Record<string, unknown>): Record<string, unknown> {
  const start = Number(v.subStart)
  const amount = Number(v.amount)
  const ok = Number.isFinite(start) && start >= 1 && Number.isFinite(amount) && amount > 0
  return { subStart: v.subStart, amount: v.amount, subEnd: ok ? start + Math.round(amount * 100) - 1 : null }
}

/**
 * 贴现利息 = 金额×利率%×(到期日−发生日)/360,银行实扣可手改(手改后只重算实收)。
 * dueDate 取自页面 pickedHolding 状态(纯函数不闭包组件状态,调用方传参)。
 */
function recalcDiscount(
  values: Record<string, unknown>,
  patch: Record<string, unknown>,
  dueDate: string | null,
  manualInterest = false
): Record<string, unknown> {
  const v = { ...values, ...patch }
  const amount = Number(v.amount)
  if (!Number.isFinite(amount)) return patch
  let interest = Number(v.interest)
  if (!manualInterest) {
    const due = dueDate ? new Date(dueDate) : null
    const on = v.occurredOn ? new Date(String(v.occurredOn)) : null
    const rate = Number(v.discountRate)
    if (due && on && Number.isFinite(rate)) {
      const days = Math.max(0, Math.round((due.getTime() - on.getTime()) / 86400000))
      interest = Math.round(amount * (rate / 100) * (days / 360) * 100) / 100
    }
  }
  return Number.isFinite(interest)
    ? { ...patch, interest, netAmount: Math.round((amount - interest) * 100) / 100 }
    : patch
}

/** 数值字段小工厂:HeroUI NumberField 包装,onChange 同时提交本字段值并把 (v, values, patchValues) 转给回调做联动计算 */
function numberInput(
  label: string,
  onCommit: (v: number | null, values: Record<string, unknown>, patch: (p: Record<string, unknown>) => void) => void
) {
  return ({ value, onChange, isDisabled, values, patchValues }: FieldInputProps) => (
    <NumberField
      fullWidth
      isDisabled={isDisabled}
      value={value == null || value === '' ? NaN : Number(value)}
      onChange={(n) => {
        const v = Number.isFinite(n) ? n : null
        onChange(v)
        onCommit(v, values, patchValues)
      }}
    >
      <Label>{label}</Label>
      <NumberField.Group className="grid-cols-[1fr]">
        <NumberField.Input />
      </NumberField.Group>
    </NumberField>
  )
}

// 银行账户候选:同公司、启用,照 bank-transactions.tsx 的动态 filter 拼法
function bankAccountFilter(values: Record<string, unknown>): string {
  const companyId = (values.companyId ?? null) as string | null
  return `{companyId: {eq: ${JSON.stringify(companyId)}}, active: {eq: true}}`
}

// onPicked:选中后追加的页面态处理(如清 pickedHolding)——不放 effects,effects 在 setValues updater 内必须纯
function bankAccountInput(label: string, placeholderWhenReady: string, onPicked?: () => void) {
  return ({ value, onChange, isDisabled, values }: FieldInputProps) => {
    const companyId = (values.companyId ?? null) as string | null
    return (
      <RemoteSelect
        resource="accBankAccounts"
        label={label}
        labelField="alias"
        searchFields={['alias', 'accountNo']}
        placeholder={companyId ? placeholderWhenReady : '先选择公司'}
        value={value == null ? null : String(value)}
        onChange={(id) => {
          onChange(id)
          onPicked?.()
        }}
        isDisabled={isDisabled || companyId == null}
        filter={bankAccountFilter(values)}
      />
    )
  }
}

// 往来/票据/结算/利息科目候选:同公司、非汇总、启用科目,照 invoices.tsx accountInput
function accountFilter(values: Record<string, unknown>): string {
  const companyId = (values.companyId ?? null) as string | null
  return `{companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}}`
}

function accountInput(label: string) {
  return ({ value, onChange, isDisabled, values }: FieldInputProps) => {
    const companyId = (values.companyId ?? null) as string | null
    return (
      <RemoteSelect
        resource="basAccounts"
        label={label}
        placeholder={companyId ? `选择${label}…` : '先选择公司'}
        value={value == null ? null : String(value)}
        onChange={(id) => onChange(id)}
        isDisabled={isDisabled || companyId == null}
        filter={accountFilter(values)}
      />
    )
  }
}

// 持有段候选:当前公司+当前银行账户下的在手票据段
function holdingFilter(values: Record<string, unknown>): string {
  const companyId = (values.companyId ?? null) as string | null
  const bankAccountId = (values.bankAccountId ?? null) as string | null
  return `{companyId: {eq: ${JSON.stringify(companyId)}}, bankAccountId: {eq: ${JSON.stringify(bankAccountId)}}}`
}

// 关联票据 fk 速览(接收交易 billId 字段本身对该类型隐藏,extraContent 里单独展示只读链接)
const BILL_FK_COL: GridColumnMeta = {
  name: 'billId',
  type: 'fk',
  label: '关联票据',
  sortable: false,
  filterable: false,
  enumOptions: null,
  ref: { resource: 'accBills', relation: null, labelField: 'billNo', discriminator: null, discriminatorType: null, variants: null },
}

function BillFaceLink({ billId }: { billId: string | null | undefined }) {
  if (!billId) return <span className="text-sm text-muted">尚未关联票据</span>
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-muted">关联票据</span>
      <div className="text-sm">
        <FkLink col={BILL_FK_COL} row={{ id: billId, billId } as Row} />
      </div>
    </div>
  )
}

const safeParseDate = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null
  try {
    return parseDate(v)
  } catch {
    return null
  }
}

/** 票面草稿日期字段:出票日期/到期日/承兑日期共用同一套 DatePicker 组装 */
function DraftDate({
  label,
  value,
  onChange,
  isRequired,
}: {
  label: string
  value: unknown
  onChange: (v: string | null) => void
  isRequired?: boolean
}) {
  return (
    <DatePicker isRequired={isRequired} value={safeParseDate(value)} onChange={(v) => onChange(v ? v.toString() : null)}>
      <Label>{label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          <DatePicker.Trigger>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover>
        <Calendar aria-label={label}>
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
            <Calendar.YearPickerGridBody>{({ year }) => <Calendar.YearPickerCell year={year} />}</Calendar.YearPickerGridBody>
          </Calendar.YearPickerGrid>
        </Calendar>
      </DatePicker.Popover>
    </DatePicker>
  )
}

function DraftBillKindSelect({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <Select value={value} onChange={(v) => onChange(v == null ? null : String(v))}>
      <Label>票据种类</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {BILL_KIND_OPTIONS.map((o) => (
            <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

function DraftTextField({
  label,
  value,
  onChange,
  isRequired,
  placeholder,
}: {
  label: string
  value: unknown
  onChange: (v: string) => void
  isRequired?: boolean
  placeholder?: string
}) {
  return (
    <TextField value={value == null ? '' : String(value)} onChange={onChange} isRequired={isRequired}>
      <Label>{label}</Label>
      <Input placeholder={placeholder} />
    </TextField>
  )
}

/** 出票人/收款人/承兑人四件套,两列排 */
function BillPartyGroup({
  title,
  prefix,
  draft,
  onChange,
}: {
  title: string
  prefix: string
  draft: Record<string, unknown>
  onChange: (key: string, value: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">{title}</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DraftTextField label="名称" value={draft[`${prefix}_name`]} onChange={(v) => onChange(`${prefix}_name`, v)} />
        <DraftTextField label="账号" value={draft[`${prefix}_account`]} onChange={(v) => onChange(`${prefix}_account`, v)} />
        <DraftTextField label="开户行" value={draft[`${prefix}_bank_name`]} onChange={(v) => onChange(`${prefix}_bank_name`, v)} />
        <DraftTextField
          label="开户行联行号"
          value={draft[`${prefix}_bank_no`]}
          onChange={(v) => onChange(`${prefix}_bank_no`, v)}
        />
      </div>
    </div>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span>{value}</span>
    </div>
  )
}

/**
 * 接收票面区:仅 create + RECEIVE 态渲染。票号失焦/按钮触发查档——
 * 命中已建档票据展示只读摘要,未命中展开票面草稿表单(snake_case 键,提交时整体作 billAttrs)。
 */
function ReceiveBillSection({
  billDraft,
  setBillDraft,
  billLookup,
  setBillLookup,
  patchValues,
}: {
  billDraft: Record<string, unknown>
  setBillDraft: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  billLookup: Row | null
  setBillLookup: (row: Row | null) => void
  patchValues: (patch: Record<string, unknown>) => void
}) {
  const [loading, setLoading] = useState(false)
  const updateDraft = (key: string, value: unknown) => setBillDraft((prev) => ({ ...prev, [key]: value }))

  const runLookup = async () => {
    const billNo = String(billDraft.bill_no ?? '').trim()
    if (!billNo) return
    setLoading(true)
    try {
      const data = await gqlFetch<{ accBills: { results: Row[] } }>(LOOKUP_BILL, { billNo })
      const hit = data.accBills.results[0] ?? null
      setBillLookup(hit)
      patchValues({ billId: hit ? hit.id : null })
    } catch (e) {
      toast.danger('票据查档失败', { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  const faceAmount = billLookup ? Number(billLookup.faceAmount) : Number(billDraft.face_amount)
  const fullBillOut = () => {
    if (!Number.isFinite(faceAmount) || faceAmount <= 0) {
      toast.danger('请先填写票据包金额,或查档命中已有票据')
      return
    }
    patchValues({ subStart: 1, amount: faceAmount, subEnd: Math.round(faceAmount * 100) })
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-default/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-medium">票面信息(接收)</span>
        <Button size="sm" variant="secondary" onPress={fullBillOut}>
          整票带出
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <TextField
          className="min-w-56"
          isRequired
          value={String(billDraft.bill_no ?? '')}
          onChange={(v) => {
            updateDraft('bill_no', v)
            if (billLookup) {
              setBillLookup(null)
              patchValues({ billId: null })
            }
          }}
          onBlur={runLookup}
        >
          <Label>票据号码</Label>
          <Input placeholder="输入票号,失焦自动查档" />
        </TextField>
        <Button size="sm" variant="secondary" isPending={loading} onPress={runLookup}>
          查档
        </Button>
      </div>

      {billLookup ? (
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-default/30 p-3 text-sm sm:grid-cols-4">
          <SummaryItem label="种类" value={BILL_KIND_LABELS[String(billLookup.billKind)] ?? String(billLookup.billKind)} />
          <SummaryItem label="到期日" value={String(billLookup.dueDate ?? '—')} />
          <SummaryItem label="金额" value={formatAmount(billLookup.faceAmount)} />
          <SummaryItem label="承兑人" value={String(billLookup.acceptorName ?? '—')} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <DraftBillKindSelect
              value={(billDraft.bill_kind as string | null) ?? null}
              onChange={(v) => updateDraft('bill_kind', v)}
            />
            <DraftDate label="出票日期" value={billDraft.issue_date} onChange={(v) => updateDraft('issue_date', v)} />
            <DraftDate label="到期日" value={billDraft.due_date} onChange={(v) => updateDraft('due_date', v)} isRequired />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <NumberField
              fullWidth
              isRequired
              value={billDraft.face_amount == null || billDraft.face_amount === '' ? NaN : Number(billDraft.face_amount)}
              onChange={(n) => updateDraft('face_amount', Number.isFinite(n) ? n : null)}
            >
              <Label>票据包金额</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
            <DraftDate label="承兑日期" value={billDraft.acceptance_date} onChange={(v) => updateDraft('acceptance_date', v)} />
            <div className="flex items-center">
              <Switch isSelected={billDraft.transferable !== false} onChange={(v) => updateDraft('transferable', v)}>
                <Switch.Content className="text-sm">
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  能否转让
                </Switch.Content>
              </Switch>
            </div>
          </div>

          <BillPartyGroup title="出票人信息" prefix="drawer" draft={billDraft} onChange={updateDraft} />
          <BillPartyGroup title="收款人信息" prefix="payee" draft={billDraft} onChange={updateDraft} />
          <BillPartyGroup title="承兑人信息" prefix="acceptor" draft={billDraft} onChange={updateDraft} />

          <DraftTextField
            label="备注"
            value={billDraft.remarks}
            onChange={(v) => updateDraft('remarks', v)}
            placeholder="选填"
          />
        </div>
      )}
    </div>
  )
}

function BillTransactionsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  // 选段整行(dueDate 供贴现算息);接收:按票号查到的既有票;接收:新票票面草稿(snake 键)
  const [pickedHolding, setPickedHolding] = useState<Row | null>(null)
  const [billLookup, setBillLookup] = useState<Row | null>(null)
  const [billDraft, setBillDraft] = useState<Record<string, unknown>>({})

  // 审核过账确认框(非调拨,需过账日期)
  const [auditDialog, setAuditDialog] = useState<{ id: string } | null>(null)
  const [auditDate, setAuditDate] = useState<string | null>(null)
  const [auditing, setAuditing] = useState(false)

  // 调拨审核确认框(不生凭证,仅变动持有库存,不收过账日期)
  const [reallocateAuditDialog, setReallocateAuditDialog] = useState<{ id: string } | null>(null)
  const [reallocateAuditing, setReallocateAuditing] = useState(false)

  const resetDraftState = () => {
    setPickedHolding(null)
    setBillLookup(null)
    setBillDraft({})
  }

  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    resetDraftState()
    setDrawer({ mode, row })
  }

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
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillTransactions'] })
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
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillTransactions'] })
    } catch (e) {
      toast.danger('审核失败', { description: (e as Error).message })
    } finally {
      setReallocateAuditing(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">承兑交易</h1>
      <p className="mt-2 text-sm text-ink-500">
        接收、转让、兑付、贴现、调拨五种承兑票据业务,草稿态可自由编辑,审核后过账并驱动持有库存重放。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="accBillTransactions"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'occurredOn', direction: 'descending' }}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionHandlers={{ audit: (rows) => openAudit(rows[0]!) }}
        />
      </div>

      <SynieRecordDrawer
        resource="accBillTransactions"
        label="承兑交易"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          setDrawer(null)
          resetDraftState()
        }}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录(同发票/流水先例)
        rowId={drawer?.row?.id}
        contentClassName="w-full lg:w-[760px]"
        exclude={EXCLUDE}
        fields={{
          transactionType: {
            required: true,
            order: -2,
            edit: 'createOnly',
            // effects 只返回字段补丁(在 setValues updater 内执行,必须纯);
            // 页面态重置(pickedHolding/billLookup/billDraft)在下方自定义 input 的 onChange 里做
            effects: () => ({
              billId: null,
              subStart: null,
              subEnd: null,
              amount: null,
              partyType: null,
              partyId: null,
              discountOrg: null,
              discountRate: null,
              interest: null,
              netAmount: null,
              toBankAccountId: null,
            }),
            input: ({ value, onChange, isDisabled }) => (
              <Select
                isDisabled={isDisabled}
                isRequired
                value={value == null ? null : String(value)}
                onChange={(v) => {
                  onChange(v == null ? null : String(v))
                  // 切类型重置接收/选段页面态,避免残留串型(与 effects 清字段配套)
                  resetDraftState()
                }}
              >
                <Label>交易类型</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {TRANSACTION_TYPE_OPTIONS.map((o) => (
                      <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                        {o.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            ),
          },
          companyId: {
            required: true,
            order: -1,
            edit: 'createOnly',
            effects: () => ({
              bankAccountId: null,
              toBankAccountId: null,
              billId: null,
              billAccountId: null,
              settleAccountId: null,
              interestAccountId: null,
            }),
            // 自定义 input 只为在 onChange 里同步清选段页面态(billId 被 effects 清空,pickedHolding 须跟着清)
            input: ({ value, onChange, isDisabled }) => (
              <RemoteSelect
                resource="basCompanies"
                label="公司"
                placeholder="选择公司…"
                value={value == null ? null : String(value)}
                onChange={(id) => {
                  onChange(id)
                  setPickedHolding(null)
                }}
                isDisabled={isDisabled}
              />
            ),
          },
          docNo: { order: 0, placeholder: '留空自动编号' },
          bankAccountId: {
            order: 1,
            required: true,
            cols: 6,
            input: bankAccountInput('银行账户', '选择账户(调拨类型即转出账户)…', () => setPickedHolding(null)),
            effects: () => ({ billId: null, subStart: null, subEnd: null, amount: null }),
          },
          toBankAccountId: {
            order: 2,
            cols: 6,
            visible: T('REALLOCATE'),
            required: false, // 后端强校验,前端提交前自查(见 onSubmit)
            input: bankAccountInput('转入账户', '选择转入账户…'),
          },
          occurredOn: { order: 3, required: true, cols: 6 },
          billId: {
            order: 4,
            cols: 6,
            // 接收:隐藏(票据由票面区建档/查档,见 extraContent);其余类型:持有段选择器
            visible: (v) => v.transactionType != null && v.transactionType !== 'RECEIVE',
            input: ({ isDisabled, values, patchValues }) => (
              <RemoteSelect
                resource="accBillHoldings"
                labelField="label"
                sortField="dueDate"
                fields={['billId', 'subStart', 'subEnd', 'amount', 'dueDate']}
                filter={holdingFilter(values)}
                label="持有段"
                placeholder="从当前持有中选择票据段…"
                value={pickedHolding?.id ?? null}
                isDisabled={isDisabled || !values.companyId || !values.bankAccountId}
                onChange={(_id, row) => {
                  setPickedHolding(row)
                  patchValues(
                    row
                      ? { billId: row.billId, subStart: row.subStart, subEnd: row.subEnd, amount: row.amount }
                      : { billId: null, subStart: null, subEnd: null, amount: null }
                  )
                }}
              />
            ),
          },
          subStart: {
            order: 5,
            cols: 4,
            required: true,
            input: numberInput('子票起', (v, values, patch) => patch(recalcSeg({ ...values, subStart: v }))),
          },
          amount: {
            order: 6,
            cols: 4,
            required: true,
            input: numberInput('交易金额', (v, values, patch) => {
              const seg = recalcSeg({ ...values, amount: v })
              // 贴现:金额变了利息必须跟着重算(自动路径,按当前利率/发生日/选段到期日),
              // 否则陈旧利息随提交入库(amount=interest+net 勾稽在注入 netAmount 后恒过,拦不住)
              const disc = T('DISCOUNT')(values)
                ? recalcDiscount({ ...values, ...seg }, {}, pickedHolding?.dueDate ? String(pickedHolding.dueDate) : null)
                : {}
              patch({ ...seg, ...disc })
            }),
          },
          subEnd: { order: 7, cols: 4, edit: 'readOnly' }, // 恒由 subStart+amount 推得
          partyType: {
            order: 8,
            cols: 6,
            visible: T('RECEIVE', 'ENDORSE'),
            effects: () => ({ partyId: null }),
          },
          partyId: {
            order: 9,
            cols: 6,
            visible: (v) => T('RECEIVE', 'ENDORSE')(v) && v.partyType != null,
            // 多态对手 input,照 invoices.tsx partyId 原样(供应商/客户/内部公司三源切换)
            input: ({ value, onChange, isDisabled, values }) => {
              const [resource, label] = PARTY_SOURCE[String(values.partyType)] ?? ['salCustomers', '对手']
              const companyId = (values.companyId ?? null) as string | null
              const filter =
                resource === 'basCompanies' && companyId ? `{id: {notEq: ${JSON.stringify(companyId)}}}` : undefined
              return (
                <RemoteSelect
                  resource={resource}
                  label={label}
                  placeholder={`选择${label}…`}
                  value={value == null ? null : String(value)}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  filter={filter}
                />
              )
            },
          },
          discountOrg: {
            order: 10,
            cols: 6,
            visible: T('DISCOUNT'),
            label: '贴现机构',
            input: ({ value, onChange, isDisabled }) => (
              <ComboBox
                allowsCustomValue
                isDisabled={isDisabled}
                inputValue={value == null ? '' : String(value)}
                onInputChange={(v) => onChange(v === '' ? null : v)}
              >
                <Label>贴现机构</Label>
                <ComboBox.InputGroup>
                  <Input placeholder="选择或输入贴现机构…" />
                  <ComboBox.Trigger />
                </ComboBox.InputGroup>
                <ComboBox.Popover>
                  <ListBox>
                    {BANKS.map((b) => (
                      <ListBox.Item key={b} id={b} textValue={b}>
                        {b}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </ComboBox.Popover>
              </ComboBox>
            ),
          },
          discountRate: {
            order: 11,
            cols: 4,
            visible: T('DISCOUNT'),
            input: numberInput('贴现利率(%)', (v, values, patch) =>
              patch(recalcDiscount(values, { discountRate: v }, pickedHolding?.dueDate ? String(pickedHolding.dueDate) : null))
            ),
          },
          interest: {
            order: 12,
            cols: 4,
            visible: T('DISCOUNT'),
            input: numberInput('贴现利息', (v, values, patch) =>
              patch(
                recalcDiscount(values, { interest: v }, pickedHolding?.dueDate ? String(pickedHolding.dueDate) : null, true)
              )
            ),
          },
          netAmount: { order: 13, cols: 4, visible: T('DISCOUNT'), edit: 'readOnly' }, // 恒 = 金额 − 利息
          billAccountId: {
            order: 14,
            cols: 4,
            visible: (v) => v.transactionType !== 'REALLOCATE',
            label: '票据科目',
            input: accountInput('票据科目'),
          },
          settleAccountId: {
            order: 15,
            cols: 4,
            visible: (v) => v.transactionType !== 'REALLOCATE',
            label: '结算科目',
            input: accountInput('结算科目'),
          },
          interestAccountId: {
            order: 16,
            cols: 4,
            visible: T('DISCOUNT'),
            label: '利息科目',
            input: accountInput('利息科目'),
          },
          remarks: { order: 17 },
        }}
        onEdit={
          drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          const txType = mode === 'view' ? (row?.transactionType as string | undefined) : (values.transactionType as string | undefined)
          const billIdForLink = mode === 'view' ? (row?.billId as string | undefined) : (values.billId as string | undefined)
          return (
            <div className="flex flex-col gap-4">
              {txType === 'RECEIVE' &&
                (mode === 'create' ? (
                  <ReceiveBillSection
                    billDraft={billDraft}
                    setBillDraft={setBillDraft}
                    billLookup={billLookup}
                    setBillLookup={setBillLookup}
                    patchValues={patchValues}
                  />
                ) : (
                  <BillFaceLink billId={billIdForLink} />
                ))}
              <SynieAttachmentPanel
                ownerType="acc_bill_transaction"
                ownerId={(row?.id as string | undefined) ?? null}
                readonly={mode === 'view'}
              />
            </div>
          )
        }}
        onSubmit={async (values, mode) => {
          const input: Record<string, unknown> = { ...values }
          // transactionType 是 createOnly:edit 态被 collectValues 剔除,自查改取原行数据(类型不可编辑,恒定)
          const txType = (mode === 'create' ? values.transactionType : drawer?.row?.transactionType) as string | undefined

          // subEnd/netAmount 是 readOnly 派生字段,collectValues 会整体剥离(同 billId 机制),
          // 而后端 sub_end 非空必填、贴现必填 net_amount——这里从已收集的 subStart/amount(/interest)
          // 统一重算注入(与 recalcSeg/recalcDiscount 同一公式同一舍入),不读表单显示值,保证两处恒一致
          const start = Number(input.subStart)
          const amount = Number(input.amount)
          if (Number.isFinite(start) && start >= 1 && Number.isFinite(amount) && amount > 0) {
            input.subEnd = start + Math.round(amount * 100) - 1
          }
          if (txType === 'DISCOUNT') {
            // interest 缺失时不注入(Number(null) 是 0,会把"利息未填"伪装成"利息为零"),留给后端必填校验报错
            const interest = input.interest == null ? NaN : Number(input.interest)
            if (Number.isFinite(amount) && Number.isFinite(interest)) {
              input.netAmount = Math.round((amount - interest) * 100) / 100
            }
          }

          if (txType === 'REALLOCATE' && !input.toBankAccountId) {
            throw new Error('调拨交易必须选择转入账户')
          }

          if (mode === 'create' && txType === 'RECEIVE') {
            if (billLookup) {
              // billId 字段对接收类型恒隐藏,不会随 collectValues 落进 values,这里显式补上
              input.billId = billLookup.id
            } else {
              const required: [string, string][] = [
                ['bill_no', '票据号码'],
                ['bill_kind', '票据种类'],
                ['due_date', '到期日'],
                ['face_amount', '票据包金额'],
              ]
              const missing = required.filter(([k]) => billDraft[k] == null || billDraft[k] === '').map(([, l]) => l)
              if (missing.length > 0) throw new Error(`请完善票面信息:${missing.join('、')}`)
              // bill_attrs 是 :map 参数,GraphQL 暴露为 JsonString 标量,写入前须序列化(照 invoices.tsx lines 先例)
              input.billAttrs = JSON.stringify(billDraft)
            }
          }

          if (mode === 'create') {
            const data = await gqlFetch<{
              createAccBillTransaction: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_BILL_TRANSACTION, { input })
            if (data.createAccBillTransaction.errors && data.createAccBillTransaction.errors.length > 0) {
              throw new Error(data.createAccBillTransaction.errors.map((e) => e.message).join('; '))
            }
            toast.success('承兑交易已创建')
          } else {
            const data = await gqlFetch<{ updateAccBillTransaction: { errors: { message: string }[] | null } }>(
              UPDATE_BILL_TRANSACTION,
              { id: drawer!.row!.id, input }
            )
            if (data.updateAccBillTransaction.errors && data.updateAccBillTransaction.errors.length > 0) {
              throw new Error(data.updateAccBillTransaction.errors.map((e) => e.message).join('; '))
            }
            toast.success('承兑交易已更新')
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillTransactions'] })
        }}
      />

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
