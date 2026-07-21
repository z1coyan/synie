import { useEffect, useRef, useState } from 'react'
import { parseDate } from '@internationalized/date'
import {
  Button,
  Calendar,
  ComboBox,
  DateField,
  DatePicker,
  Disclosure,
  Input,
  Label,
  ListBox,
  NumberField,
  Select,
  Separator,
  Switch,
  TextField,
  toast,
} from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { BANKS } from '~/lib/banks'
import { attachFile, type UploadedFile } from '~/lib/files'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieOcrButton } from '~/components/synie-ocr-button/SynieOcrButton'
import { FileThumb } from '~/components/synie-preview/FileThumb'
import { SyniePreview } from '~/components/synie-preview/SyniePreview'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { FkLink } from '~/components/synie-record-drawer/fk-preview'
import type { FieldInputProps } from '~/components/synie-record-drawer/fields'
import type { GridColumnMeta, Row } from '~/components/synie-data-grid/types'

/**
 * 承兑交易三态抽屉(交易/持有两 tab 共用,TanStack Router 按 `-` 前缀不当路由)。
 * 创建一律定型:接收从交易 tab 发起,转让/兑付/贴现/调拨从持有 tab 的票据段行发起
 * (类型不可改,持有段整行灌入表单预填),故不再有「先选类型」的空白创建态。
 */
export type TxType = 'RECEIVE' | 'ENDORSE' | 'SETTLE' | 'DISCOUNT' | 'REALLOCATE'

export const TX_TYPE_LABEL: Record<TxType, string> = {
  RECEIVE: '接收',
  ENDORSE: '转让',
  SETTLE: '兑付',
  DISCOUNT: '贴现',
  REALLOCATE: '调拨',
}

export type TransactionDrawerState =
  | { mode: 'create'; txType: TxType; holding?: Row | null }
  | { mode: 'view' | 'edit'; row: Row }

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
// 票号查档:命中已建档票据(接收票面区,详见 ReceiveBillSection)
const LOOKUP_BILL = `
  query ($billNo: String!) {
    accBills(filter: {billNo: {eq: $billNo}}, limit: 1, offset: 0) {
      results { id billNo billKind dueDate drawerName acceptorName }
    }
  }
`
// OCR generic action:返回票面草稿(snake_case)+ 子票段字段(sub_start/sub_end/amount)JSON,不落库
const OCR_BILL = `
  mutation ($input: OcrAccBillTransactionInput!) {
    ocrAccBillTransaction(input: $input)
  }
`
// 暂存附件被替换(重复 OCR)时尽力清理旧裸文件;失败静默(不挂接即不可见)
const DESTROY_FILE = `
  mutation ($id: ID!) {
    destroySysFile(id: $id) { result { id } errors { message } }
  }
`

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
 * dueDate 取自组件 pickedHolding 状态(纯函数不闭包组件状态,调用方传参)。
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
  onCommit: (v: number | null, values: Record<string, unknown>, patch: (p: Record<string, unknown>) => void) => void,
  required = false
) {
  return ({ value, onChange, isDisabled, values, patchValues }: FieldInputProps) => (
    <NumberField
      fullWidth
      isRequired={required}
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
function bankAccountInput(label: string, placeholderWhenReady: string, onPicked?: () => void, required = false) {
  return ({ value, onChange, isDisabled, values }: FieldInputProps) => {
    const companyId = (values.companyId ?? null) as string | null
    return (
      <RemoteSelect
        resource="accBankAccounts"
        label={label}
        labelField="alias"
        searchFields={['alias', 'accountNo']}
        isRequired={required}
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

export const safeParseDate = (v: unknown) => {
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
    <Select isRequired value={value} onChange={(v) => onChange(v == null ? null : String(v))}>
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
 * 接收票面区:仅 create + RECEIVE 态渲染,置于抽屉最顶部(headerContent)——
 * 录入动线从票面开始:OCR 识图回填票面草稿并带出子票段,或票号失焦/按钮触发查档,
 * 命中已建档票据展示只读摘要,未命中展开票面草稿表单(snake_case 键,提交时整体作 billAttrs)。
 * 票面原图占本区专属槽位(缩略图可预览、可移除),不与底部「附件」混淆——
 * 底部附件面板只承载合同/回单等额外文件,整个表单的图片上传入口就此收敛为一处主动作。
 */
function ReceiveBillSection({
  billDraft,
  setBillDraft,
  billLookup,
  setBillLookup,
  patchValues,
  ocrFile,
  onOcrFile,
  onOcrRemove,
}: {
  billDraft: Record<string, unknown>
  setBillDraft: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  billLookup: Row | null
  setBillLookup: (row: Row | null) => void
  patchValues: (patch: Record<string, unknown>) => void
  ocrFile: UploadedFile | null
  onOcrFile: (file: UploadedFile) => void
  onOcrRemove: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const updateDraft = (key: string, value: unknown) => setBillDraft((prev) => ({ ...prev, [key]: value }))

  const runLookup = async (billNoArg?: string) => {
    const billNo = (billNoArg ?? String(billDraft.bill_no ?? '')).trim()
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">票面信息</span>
          <span className="text-xs text-muted">上传票面自动识别回填;票号命中已有档案自动挂接</span>
        </div>
        <SynieOcrButton
          mutation={OCR_BILL}
          resultKey="ocrAccBillTransaction"
          accept="image/*"
          variant="primary"
          label={ocrFile ? '重新识别' : '上传票面识别'}
          onRecognized={(fields, file) => {
            // 子票段是交易字段,不进票面草稿:拆出后回填表单(勾稽公式与后端 mapper 一致)
            const { sub_start: subStart, sub_end: subEnd, amount, ...face } = fields
            // 识别视为换票:清查档命中,票面并入草稿后按新票号自动查档
            setBillLookup(null)
            const patch: Record<string, unknown> = { billId: null }
            if (subStart != null && amount != null) {
              patch.subStart = Number(subStart)
              patch.subEnd = subEnd == null ? null : Number(subEnd)
              patch.amount = Number(amount)
            }
            patchValues(patch)
            setBillDraft((prev) => ({ ...prev, ...face }))
            onOcrFile(file)
            const billNo = typeof face.bill_no === 'string' ? face.bill_no.trim() : ''
            if (billNo) void runLookup(billNo)
          }}
        />
      </div>

      {ocrFile && (
        <>
          <div className="flex items-center gap-3 rounded-2xl border border-border px-3 py-2">
            <FileThumb fileId={ocrFile.id} alt={ocrFile.filename} onPress={() => setPreviewOpen(true)} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" title={ocrFile.filename}>
                {ocrFile.filename}
              </p>
              <p className="text-xs text-muted">票面原图 · 保存时自动挂接为附件</p>
            </div>
            <Button size="sm" variant="ghost" onPress={onOcrRemove}>
              移除
            </Button>
          </div>
          <SyniePreview
            items={[{ fileId: ocrFile.id, filename: ocrFile.filename }]}
            isOpen={previewOpen}
            onOpenChange={setPreviewOpen}
          />
        </>
      )}

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
          onBlur={() => runLookup()}
        >
          <Label>票据号码</Label>
          <Input placeholder="输入票号,失焦自动查档" />
        </TextField>
        <Button size="sm" variant="secondary" isPending={loading} onPress={() => runLookup()}>
          查档
        </Button>
      </div>

      {billLookup ? (
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-default/30 p-3 text-sm sm:grid-cols-4">
          <SummaryItem label="种类" value={BILL_KIND_LABELS[String(billLookup.billKind)] ?? String(billLookup.billKind)} />
          <SummaryItem label="到期日" value={String(billLookup.dueDate ?? '—')} />
          <SummaryItem label="出票人" value={String(billLookup.drawerName ?? '—')} />
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

          {/* 出票人等 12 个字段基本靠 OCR 回填、极少手录,默认折叠压掉表单长度;
              折叠不影响值:草稿状态在父级,识别回填后收起也照常提交 */}
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="text-sm text-muted">
                出票人 / 收款人 / 承兑人信息(选填,识别自动回填)
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="flex flex-col gap-4 pt-3">
                <BillPartyGroup title="出票人信息" prefix="drawer" draft={billDraft} onChange={updateDraft} />
                <BillPartyGroup title="收款人信息" prefix="payee" draft={billDraft} onChange={updateDraft} />
                <BillPartyGroup title="承兑人信息" prefix="acceptor" draft={billDraft} onChange={updateDraft} />
                <DraftTextField
                  label="票面备注"
                  value={billDraft.remarks}
                  onChange={(v) => updateDraft('remarks', v)}
                  placeholder="选填"
                />
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        </div>
      )}
    </div>
  )
}

export function AcceptanceTransactionDrawer({
  state,
  onStateChange,
  onMutated,
}: {
  state: TransactionDrawerState | null
  /** 抽屉状态全由页面持有:关闭传 null,view→edit 切换传 edit 态 */
  onStateChange: (s: TransactionDrawerState | null) => void
  /** 写成功后回调:页面统一失效交易/持有/票据缓存 */
  onMutated: () => void
}) {
  // 退场动画期间冻结最后一次打开的状态(RecordDrawer 只冻结自己的 mode/row,
  // 这里的标题 label/预填 fields 派生自 state,也得跟着冻结,否则关闭瞬间闪回默认文案)
  const lastRef = useRef<TransactionDrawerState | null>(null)
  if (state) lastRef.current = state
  const s = state ?? lastRef.current

  const mode = s?.mode ?? 'view'
  const row = s && s.mode !== 'create' ? s.row : null
  const createType = s?.mode === 'create' ? s.txType : null
  const holding = s?.mode === 'create' ? (s.holding ?? null) : null

  // 选段整行(dueDate 供贴现算息);接收:按票号查到的既有票;接收:新票票面草稿(snake 键)
  const [pickedHolding, setPickedHolding] = useState<Row | null>(null)
  const [billLookup, setBillLookup] = useState<Row | null>(null)
  const [billDraft, setBillDraft] = useState<Record<string, unknown>>({})
  // 创建态暂存附件(合同/回单等额外文件):先传裸文件,创建成功后统一挂接;抽屉重开即清空
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([])
  // 票面原图独立槽位(票面区展示/预览/移除),与上面的额外附件分开;重复识别视为换图
  const [ocrFile, setOcrFile] = useState<UploadedFile | null>(null)

  const handleOcrFile = (file: UploadedFile) => {
    const prev = ocrFile
    setOcrFile(file)
    if (prev) void gqlFetch(DESTROY_FILE, { id: prev.id }).catch(() => undefined)
  }

  const handleOcrRemove = () => {
    const prev = ocrFile
    setOcrFile(null)
    if (prev) void gqlFetch(DESTROY_FILE, { id: prev.id }).catch(() => undefined)
  }

  // 打开时初始化组件态:从持有段发起的创建把该段整行灌入选段状态
  useEffect(() => {
    if (!state) return
    setPickedHolding(state.mode === 'create' ? (state.holding ?? null) : null)
    setBillLookup(null)
    setBillDraft({})
    setPendingFiles([])
    setOcrFile(null)
  }, [state])

  // 布局随类型微调:贴现要排三个科目(4/4/4),其余类型两个科目对半(6/6)
  const layoutType = createType ?? (row?.transactionType as string | undefined)
  const accountCols = layoutType === 'DISCOUNT' ? 4 : 6
  // 接收的票/段来自票面区(OCR/查档回填),与公司、账户选择无关;
  // 持有段类型换公司/账户则必须清选段(候选集变了)——effects 按类型二分
  const isReceive = layoutType === 'RECEIVE'

  return (
    <SynieRecordDrawer
      resource="accBillTransactions"
      label={createType ? `承兑${TX_TYPE_LABEL[createType]}` : '承兑交易'}
      mode={mode}
      isOpen={state !== null}
      onOpenChange={(open) => !open && onStateChange(null)}
      // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录(同发票/流水先例)
      rowId={row?.id}
      contentClassName="w-full lg:w-[760px]"
      exclude={EXCLUDE}
      fields={{
        // 类型随入口定死(接收在交易 tab,其余从持有段行发起):创建态标题已表意,
        // 不再占一行渲染只读字段(defaultValue 仍种进草稿,T() 显隐联动照常);查看/编辑态照常展示
        transactionType: {
          order: -2,
          edit: 'readOnly',
          defaultValue: createType,
          visible: mode === 'create' ? () => false : undefined,
        },
        companyId: {
          required: true,
          order: -1,
          cols: 6,
          edit: 'createOnly',
          defaultValue: holding?.companyId == null ? undefined : String(holding.companyId),
          effects: () => ({
            bankAccountId: null,
            toBankAccountId: null,
            billAccountId: null,
            settleAccountId: null,
            interestAccountId: null,
            // 接收的 billId 由票面区查档/建档决定,不随公司清
            ...(isReceive ? {} : { billId: null }),
          }),
          // 自定义 input 只为在 onChange 里同步清选段页面态(billId 被 effects 清空,pickedHolding 须跟着清)
          input: ({ value, onChange, isDisabled }) => (
            <RemoteSelect
              resource="basCompanies"
              label="公司"
              isRequired
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
        docNo: { order: 0, cols: 6, placeholder: '留空自动编号' },
        bankAccountId: {
          order: 1,
          required: true,
          cols: 6,
          // meta 长标签「本方银行账户(调拨为转出账户)」在表单/校验提示里啰嗦,按类型给短名
          label: layoutType === 'REALLOCATE' ? '转出账户' : '银行账户',
          defaultValue: holding?.bankAccountId == null ? undefined : String(holding.bankAccountId),
          input: bankAccountInput(
            layoutType === 'REALLOCATE' ? '转出账户' : '银行账户',
            '选择银行账户…',
            () => setPickedHolding(null),
            true
          ),
          // 接收:账户只是持有落点,不动票/段(OCR/查档回填在先,选账户在后,清了就白填)
          effects: isReceive ? undefined : () => ({ billId: null, subStart: null, subEnd: null, amount: null }),
        },
        toBankAccountId: {
          order: 2,
          cols: 6,
          visible: T('REALLOCATE'),
          required: true, // required 只对可见字段生效,调拨之外不受影响;onSubmit 仍留兜底自查
          input: bankAccountInput('转入账户', '选择转入账户…', undefined, true),
        },
        occurredOn: { order: 3, required: true, cols: 6 },
        billId: {
          order: 4,
          cols: 12,
          required: true, // 仅对可见态(非接收)生效:非接收必须选持有段
          defaultValue: holding?.billId == null ? undefined : String(holding.billId),
          // 接收:隐藏(票据由票面区建档/查档,见 headerContent);其余类型:持有段选择器
          visible: (v) => v.transactionType != null && v.transactionType !== 'RECEIVE',
          input: ({ isDisabled, values, patchValues }) => (
            <RemoteSelect
              resource="accBillHoldings"
              labelField="label"
              isRequired
              searchFields={['billNo']}
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
          // 接收缺省整票从 1 起(OCR 识别到子票区间会覆盖);段行发起的类型取该段起号
          defaultValue: holding?.subStart != null ? Number(holding.subStart) : createType === 'RECEIVE' ? 1 : undefined,
          input: numberInput('子票起', (v, values, patch) => patch(recalcSeg({ ...values, subStart: v })), true),
        },
        amount: {
          order: 6,
          cols: 4,
          required: true,
          label: '交易金额',
          render: (v) => formatAmount(v),
          defaultValue: holding?.amount == null ? undefined : Number(holding.amount),
          input: numberInput(
            '交易金额',
            (v, values, patch) => {
              const seg = recalcSeg({ ...values, amount: v })
              // 贴现:金额变了利息必须跟着重算(自动路径,按当前利率/发生日/选段到期日),
              // 否则陈旧利息随提交入库(amount=interest+net 勾稽在注入 netAmount 后恒过,拦不住)
              const disc = T('DISCOUNT')(values)
                ? recalcDiscount({ ...values, ...seg }, {}, pickedHolding?.dueDate ? String(pickedHolding.dueDate) : null)
                : {}
              patch({ ...seg, ...disc })
            },
            true
          ),
        },
        subEnd: {
          order: 7,
          cols: 4,
          edit: 'readOnly', // 恒由 subStart+amount 推得
          defaultValue: holding?.subEnd == null ? undefined : Number(holding.subEnd),
        },
        partyType: {
          order: 8,
          cols: 6,
          required: true, // 接收/转让必填对手(与后端矩阵一致);其余类型不可见即不校验
          visible: T('RECEIVE', 'ENDORSE'),
          effects: () => ({ partyId: null }),
        },
        partyId: {
          order: 9,
          cols: 6,
          required: true,
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
                isRequired
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
          required: true, // 贴现四件后端必填,前端同步预检+星号
          label: '贴现机构',
          input: ({ value, onChange, isDisabled }) => (
            <ComboBox
              allowsCustomValue
              isRequired
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
          cols: 6,
          visible: T('DISCOUNT'),
          required: true,
          input: numberInput(
            '贴现利率(%)',
            (v, values, patch) =>
              patch(
                recalcDiscount(values, { discountRate: v }, pickedHolding?.dueDate ? String(pickedHolding.dueDate) : null)
              ),
            true
          ),
        },
        interest: {
          order: 12,
          cols: 6,
          visible: T('DISCOUNT'),
          required: true,
          render: (v) => formatAmount(v),
          input: numberInput(
            '贴现利息',
            (v, values, patch) =>
              patch(
                recalcDiscount(values, { interest: v }, pickedHolding?.dueDate ? String(pickedHolding.dueDate) : null, true)
              ),
            true
          ),
        },
        // 恒 = 金额 − 利息
        netAmount: { order: 13, cols: 6, visible: T('DISCOUNT'), edit: 'readOnly', render: (v) => formatAmount(v) },
        billAccountId: {
          order: 14,
          cols: accountCols,
          visible: (v) => v.transactionType !== 'REALLOCATE',
          label: '票据科目',
          input: accountInput('票据科目'),
        },
        settleAccountId: {
          order: 15,
          cols: accountCols,
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
      onEdit={row?.status === 'DRAFT' ? () => onStateChange({ mode: 'edit', row: row! }) : undefined}
      // 接收创建的动线从票面开始:票面区(含 OCR 主动作)置顶,识别/查档随即回填下方交易字段;
      // 三段(票面/交易/附件)用分隔线统一节奏,票面原图槽位在票面区,底部附件只装额外文件
      headerContent={(mode, _row, values, patchValues) => {
        if (mode !== 'create' || values.transactionType !== 'RECEIVE') return null
        return (
          <div className="flex flex-col gap-5">
            <ReceiveBillSection
              billDraft={billDraft}
              setBillDraft={setBillDraft}
              billLookup={billLookup}
              setBillLookup={setBillLookup}
              patchValues={patchValues}
              ocrFile={ocrFile}
              onOcrFile={handleOcrFile}
              onOcrRemove={handleOcrRemove}
            />
            <Separator />
            <span className="text-sm font-medium">交易信息</span>
          </div>
        )
      }}
      extraContent={(mode, row, values) => {
        const txType = mode === 'view' ? (row?.transactionType as string | undefined) : (values.transactionType as string | undefined)
        const billIdForLink = mode === 'view' ? (row?.billId as string | undefined) : (values.billId as string | undefined)
        return (
          <div className="flex flex-col gap-5">
            <Separator />
            {txType === 'RECEIVE' && mode !== 'create' && <BillFaceLink billId={billIdForLink} />}
            <SynieAttachmentPanel
              ownerType="acc_bill_transaction"
              ownerId={(row?.id as string | undefined) ?? null}
              readonly={mode === 'view'}
              // 创建态走暂存(额外文件;票面原图在票面区槽位),保存成功后统一挂接
              pending={
                mode === 'create'
                  ? {
                      files: pendingFiles,
                      onAdd: (f) => setPendingFiles((fs) => [...fs, f]),
                      onRemove: (id) => setPendingFiles((fs) => fs.filter((f) => f.id !== id)),
                    }
                  : undefined
              }
            />
          </div>
        )
      }}
      onSubmit={async (values, mode) => {
        // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
        let savedId: string
        const input: Record<string, unknown> = { ...values }
        // transactionType 只读展示,collectValues 会剥离:create 取入口定死的类型显式注入,edit 取原行数据(恒定)
        const txType = (mode === 'create' ? createType : row?.transactionType) as string | undefined
        if (mode === 'create') input.transactionType = txType

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
          savedId = data.createAccBillTransaction.result!.id
          // 暂存附件(票面原图+额外文件)统一挂接;个别失败不阻断建单,提示手工补传即可
          const failed: string[] = []
          for (const f of [...(ocrFile ? [ocrFile] : []), ...pendingFiles]) {
            try {
              await attachFile(f.id, {
                ownerType: 'acc_bill_transaction',
                ownerId: data.createAccBillTransaction.result!.id,
              })
            } catch {
              failed.push(f.filename)
            }
          }
          if (failed.length > 0) {
            toast.warning(`交易已创建,但附件挂接失败:${failed.join('、')},请在附件面板手工补传`)
          }
          toast.success(`承兑${TX_TYPE_LABEL[(txType ?? 'RECEIVE') as TxType] ?? '交易'}已创建`)
        } else {
          const data = await gqlFetch<{ updateAccBillTransaction: { errors: { message: string }[] | null } }>(
            UPDATE_BILL_TRANSACTION,
            { id: row!.id, input }
          )
          if (data.updateAccBillTransaction.errors && data.updateAccBillTransaction.errors.length > 0) {
            throw new Error(data.updateAccBillTransaction.errors.map((e) => e.message).join('; '))
          }
          toast.success('承兑交易已更新')
          savedId = row!.id
        }
        onMutated()
        return savedId
      }}
    />
  )
}
