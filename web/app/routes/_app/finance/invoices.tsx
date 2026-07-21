import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { parseDate } from '@internationalized/date'
import {
  AlertDialog,
  Button,
  Calendar,
  DateField,
  DatePicker,
  Input,
  Label,
  TextField,
  toast,
} from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { amountInWords, formatAmount } from '~/lib/amount'
import { UUID_RE } from '~/components/synie-data-grid/query'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer, type DrawerExtraContent } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { localRowId } from '~/components/synie-editable-table/editable'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { attachFile, type UploadedFile } from '~/lib/files'
import { SynieOcrButton } from '~/components/synie-ocr-button/SynieOcrButton'
import type { DrawerMode, FieldInputProps } from '~/components/synie-record-drawer/fields'
import type { LocalGridMeta, Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/invoices')({
  component: InvoicesPage,
})

const CREATE_INVOICE = `
  mutation ($input: CreateAccVatInvoiceInput!) {
    createAccVatInvoice(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_INVOICE = `
  mutation ($id: ID!, $input: UpdateAccVatInvoiceInput!) {
    updateAccVatInvoice(id: $id, input: $input) { result { id } errors { message } }
  }
`
const AUDIT_INVOICE = `
  mutation ($id: ID!, $input: AuditAccVatInvoiceInput!) {
    auditAccVatInvoice(id: $id, input: $input) { result { id } errors { message } }
  }
`
const REVERSE_INVOICE = `
  mutation ($id: ID!, $input: ReverseAccVatInvoiceInput!) {
    reverseAccVatInvoice(id: $id, input: $input) { result { id } errors { message } }
  }
`
// OCR generic action:返回识别字段 JSON,不落库
const OCR_INVOICE = `
  mutation ($input: OcrAccVatInvoiceInput!) {
    ocrAccVatInvoice(input: $input)
  }
`
// 发票明细(items)与头一起挂在同一条记录上,不是独立资源;开抽屉时单独取一次
// (rowId 自查已覆盖表单字段,这里只为局部初始化本地清单状态,轻量、不重复整行)
const FETCH_ITEMS = `
  query ($id: ID!) {
    accVatInvoices(filter: {id: {eq: $id}}, limit: 1, offset: 0) {
      results { items }
    }
  }
`

// 销售清单行结构 = OCR 目标 schema;纯文本档案,不关联物料
const ITEM_META: LocalGridMeta = {
  columns: [
    { name: 'name', type: 'string', label: '物料名称', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'model', type: 'string', label: '规格型号', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'unit', type: 'string', label: '单位', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'quantity', type: 'decimal', label: '数量', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'price', type: 'decimal', label: '单价', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'net_amount', type: 'decimal', label: '金额', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'tax_rate', type: 'string', label: '税率', sortable: false, filterable: false, enumOptions: null, ref: null },
    { name: 'tax_amount', type: 'decimal', label: '税额', sortable: false, filterable: false, enumOptions: null, ref: null },
  ],
}

/**
 * items 读写两端形态不对称(同 sys_numbering_rule.segments 先例):
 * 查询读回是整条 JsonString(全数组一次序列化);create/update 写入要 [JsonString!](逐行各自序列化)。
 * parse 时优先按整串 parse,兼容万一拿到数组(防御性,不假设上游形态)。
 */
function parseItems(raw: unknown): Row[] {
  if (typeof raw === 'string' && raw !== '') {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return arr.map((it) => ({ id: localRowId(), ...(it as object) }) as Row)
    } catch {
      // 解析失败按空清单处理,不让抽屉崩掉
    }
  }
  if (Array.isArray(raw)) {
    return raw.map((s) => ({ id: localRowId(), ...(typeof s === 'string' ? JSON.parse(s) : (s as object)) }) as Row)
  }
  return []
}

function serializeItems(items: Row[]): string[] {
  return items.map(({ id: _id, ...rest }) => JSON.stringify(rest))
}

const GRID_COLUMNS = [
  'companyId',
  'docNo',
  'direction',
  'partyId',
  'salReconciliationId',
  'invoiceKind',
  'invoiceNo',
  'invoiceDate',
  'grossTotal',
  'status',
  'auditedById',
]

// 状态胶囊配色:草稿灰、已审核绿、已作废红、已红冲橙
const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger', REVERSED: 'warning' } },
  grossTotal: { render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>

// 对手候选数据源按 partyType 切换;COMPANY(内部公司对向发票)用公司主数据
const PARTY_SOURCE: Record<string, [resource: string, label: string]> = {
  SUPPLIER: ['purSuppliers', '供应商'],
  CUSTOMER: ['salCustomers', '客户'],
  COMPANY: ['basCompanies', '内部公司'],
}

// 新增发票先选类型:类型定死方向与对手类型,选定后由选择器写入表单草稿(direction/partyType
// 字段创建态隐藏)。每类发票必须关联上级表单:采购对账单规划中,采购开入暂不可选;
// 费用报销(员工对手)规划中——PartyType 枚举尚无员工类型
type InvoiceCreateType = 'sales' | 'internal'
const INVOICE_CREATE_TYPES = [
  { key: 'sales', label: '销售开出', desc: '向客户开具销项发票', disabled: false, preset: { direction: 'OUTBOUND', partyType: 'CUSTOMER' } },
  { key: 'internal', label: '内部互开', desc: '内部公司互开,保存后可生成对向发票', disabled: false, preset: { direction: 'OUTBOUND', partyType: 'COMPANY' } },
  { key: 'purchase', label: '采购开入', desc: '采购对账单(规划中)', disabled: true, preset: null },
  { key: 'expense', label: '费用报销', desc: '规划中', disabled: true, preset: null },
] as const

// 往来/金额/税额三科目候选限定在当前选择的公司、非汇总、启用科目(同 journals/bank-accounts 科目 filter 先例);
// fields 是静态声明,读不到实时表单值,故用自定义 input 直接从 values.companyId 取
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
        filter={`{companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}}`}
      />
    )
  }
}

// 关联销售对账单候选限:本公司、本对手、客户已确认、常规类型(与后端 VatInvoiceReconciliationLink/审核校验同口径);
// 对手类型是枚举,filter 里用裸 token(同 accountFilter 先例)
function reconciliationFilter(values: Record<string, unknown>): string | undefined {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return undefined
  return `{and: [{companyId: {eq: ${JSON.stringify(String(companyId))}}}, {partyType: {eq: ${String(partyType)}}}, {partyId: {eq: ${JSON.stringify(String(partyId))}}}, {status: {eq: CONFIRMED}}, {reconciliationType: {eq: REGULAR}}]}`
}

/**
 * 「关联销售对账单」字段:仅开出发票草稿可改。下拉限本公司本对手、客户已确认的常规单;
 * 选中后展示对账单本币含税合计,与发票价税合计不等时红色提示(后端审核强校验一对一且相等)。
 */
function ReconciliationLinkInput({ value, onChange, isDisabled, values }: FieldInputProps) {
  const id = value == null || value === '' ? null : String(value)
  const filter = reconciliationFilter(values)

  // 选中/回显的对账单合计:编辑态初值无行数据,按 id 自查一次(RemoteSelect 只回 labelField 集)
  const recQuery = useQuery({
    queryKey: ['salReconciliations', 'linkHint', id],
    enabled: id != null && UUID_RE.test(id),
    queryFn: () =>
      gqlFetch<{ salReconciliations: { results: Row[] } }>(
        `query ($id: ID!) {
          salReconciliations(filter: {id: {eq: $id}}, limit: 1, offset: 0) {
            results { id reconciliationNo status baseGrossTotal }
          }
        }`,
        { id },
      ).then((d) => d.salReconciliations.results[0] ?? null),
  })

  const rec = recQuery.data ?? null
  const gross = values.grossTotal == null || values.grossTotal === '' ? null : Number(values.grossTotal)
  const recTotal = rec?.baseGrossTotal == null ? null : Number(rec.baseGrossTotal)
  const mismatch = gross != null && recTotal != null && Math.abs(gross - recTotal) > 0.005

  return (
    <div className="flex flex-col gap-1">
      <RemoteSelect
        resource="salReconciliations"
        label="关联销售对账单"
        isRequired
        placeholder={filter ? '选择客户已确认的常规对账单…' : '先选齐公司与对手'}
        labelField="reconciliationNo"
        searchFields={['reconciliationNo']}
        value={id}
        onChange={(rid) => onChange(rid)}
        isDisabled={isDisabled || filter == null}
        filter={filter}
      />
      {rec && (
        <p className={`text-xs ${mismatch ? 'text-danger' : 'text-muted'}`}>
          对账单本币含税合计 {formatAmount(rec.baseGrossTotal)};审核要求与发票价税合计相等
          {mismatch ? `(当前价税合计 ${formatAmount(gross)},不相等)` : ''}
        </p>
      )}
    </div>
  )
}

/** 新增发票类型选择卡(仅 create 态,抽屉顶部 headerContent);disabled 项为规划中占位 */
function InvoiceTypePicker({
  value,
  onChange,
}: {
  value: InvoiceCreateType | null
  onChange: (t: (typeof INVOICE_CREATE_TYPES)[number]) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {INVOICE_CREATE_TYPES.map((t) => (
        <button
          key={t.key}
          type="button"
          disabled={t.disabled}
          aria-pressed={value === t.key}
          onClick={() => onChange(t)}
          className={`rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            value === t.key ? 'border-accent' : 'border-border hover:border-accent/60'
          }`}
        >
          <p className="text-sm font-medium">{t.label}</p>
          <p className="mt-0.5 text-xs text-muted">{t.desc}</p>
        </button>
      ))}
    </div>
  )
}

// 镜像 input 直接透传的票面/明细字段(科目、doc_no、postingDate 不带——对方需自行补科目并审核)
const MIRROR_COPY_FIELDS = [
  'invoiceDate',
  'invoiceKind',
  'invoiceCode',
  'invoiceNo',
  'sellerName',
  'sellerTaxNo',
  'sellerAddressPhone',
  'sellerBankAccount',
  'buyerName',
  'buyerTaxNo',
  'buyerAddressPhone',
  'buyerBankAccount',
  'items',
  'netTotal',
  'taxTotal',
  'grossTotal',
  'issuer',
  'reviewer',
  'payee',
  'remarks',
] as const

/** 对向发票 input:company↔party 互换、方向取反、票面字段原样;科目/doc_no/postingDate 不带 */
function buildMirrorInput(src: Row): Record<string, unknown> {
  return {
    ...Object.fromEntries(MIRROR_COPY_FIELDS.map((k) => [k, src[k] ?? null])),
    companyId: src.partyId,
    partyType: 'COMPANY',
    partyId: src.companyId,
    direction: src.direction === 'OUTBOUND' ? 'INBOUND' : 'OUTBOUND',
    mirrorInvoiceId: src.id,
  }
}

const safeParseDate = (v: string | null) => {
  if (!v) return null
  try {
    return parseDate(v)
  } catch {
    return null
  }
}

function InvoicesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  // 退场动画期间冻结最后打开的抽屉态(承兑抽屉 lastRef 先例):fields/headerContent 闭包
  // 读 isCreate/createType,关闭瞬间 drawer 已置 null,不冻结会闪回非创建态排布
  const lastDrawerRef = useRef(drawer)
  if (drawer) lastDrawerRef.current = drawer
  const isCreate = (drawer ?? lastDrawerRef.current)?.mode === 'create'
  // 新增发票类型(仅 create 态顶部选择卡);开抽屉时重置,关闭不清(配合上方冻结不闪)
  const [createType, setCreateType] = useState<InvoiceCreateType | null>(null)
  // create 态暂存附件:先传裸文件进父级状态,创建成功后统一 attachFile(同承兑交易抽屉先例)
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([])

  // 字段布局(order/section)按态二分:create 态「OCR 优先」——手工字段(公司/对手/关联对账单/
  // 三科目)置顶「基本信息」,票面等 OCR 填充后核对,金额与清单收尾;edit/view 态保持五组现状
  const layout: Record<string, [order: number, section?: string]> = isCreate
    ? {
        companyId: [-1, '基本信息'],
        docNo: [0],
        direction: [1],
        partyType: [2],
        partyId: [3],
        salReconciliationId: [4],
        partyAccountId: [5],
        amountAccountId: [6],
        taxAccountId: [7],
        invoiceKind: [10, '票面信息(OCR 填充,请核对)'],
        invoiceCode: [11],
        invoiceNo: [12],
        invoiceDate: [13],
        buyerName: [14],
        buyerTaxNo: [15],
        buyerAddressPhone: [16],
        buyerBankAccount: [17],
        sellerName: [18],
        sellerTaxNo: [19],
        sellerAddressPhone: [20],
        sellerBankAccount: [21],
        issuer: [22],
        reviewer: [23],
        payee: [24],
        netTotal: [30, '金额与清单'],
        taxTotal: [31],
        grossTotal: [32],
        mirrorInvoiceId: [60, ''],
        remarks: [61, ''],
      }
    : {
        companyId: [-1, '基本信息'],
        docNo: [1],
        direction: [2],
        invoiceKind: [3],
        invoiceDate: [4],
        invoiceCode: [10, '票面信息'],
        invoiceNo: [11],
        issuer: [12],
        reviewer: [13],
        payee: [14],
        partyType: [20, '购销双方'],
        partyId: [21, '购销双方'],
        buyerName: [22],
        buyerTaxNo: [23],
        buyerAddressPhone: [24],
        buyerBankAccount: [25],
        sellerName: [26],
        sellerTaxNo: [27],
        sellerAddressPhone: [28],
        sellerBankAccount: [29],
        netTotal: [40, '金额与科目'],
        taxTotal: [41],
        grossTotal: [42],
        partyAccountId: [43],
        amountAccountId: [44],
        taxAccountId: [45],
        salReconciliationId: [50, '关联'],
        mirrorInvoiceId: [51, '关联'],
        remarks: [60, ''],
      }
  const lay = (key: string) => {
    const [order, section] = layout[key] ?? [0]
    return { order, section }
  }

  // OCR 区(识别按钮+附件面板):create 态经 invoiceKind 的 before 插槽锚在「票面信息」组标题
  // 正上方——填完「基本信息」即传附件点识别,票面字段随即在下方核对;edit/view 态不渲染
  // (附件面板留在 extraContent 尾部)。识别回填/ocrFileRef 补挂/pending 暂存逻辑不变
  const ocrZone: DrawerExtraContent = (mode, row, _values, patchValues) => {
    if (mode !== 'create') return null
    return (
      <div className="flex flex-col gap-4">
        <SynieOcrButton
          mutation={OCR_INVOICE}
          resultKey="ocrAccVatInvoice"
          accept="image/*,.pdf"
          onRecognized={(fields, file) => {
            // items 走本地清单状态,其余字段直接回填表单草稿
            const { items: ocrItems, ...rest } = fields
            patchValues(rest)
            if (Array.isArray(ocrItems) && ocrItems.length > 0) {
              setItems(ocrItems.map((it) => ({ id: localRowId(), ...(it as object) }) as Row))
            }
            ocrFileRef.current = file.id
          }}
        />
        <SynieAttachmentPanel
          ownerType="acc_vat_invoice"
          ownerId={(row?.id as string | undefined) ?? null}
          category="original"
          // 创建态走暂存(同承兑交易抽屉先例),保存成功后统一挂接;
          // OCR 原图走 ocrFileRef 独立补挂,不进此列表
          pending={{
            files: pendingFiles,
            onAdd: (f) => setPendingFiles((fs) => [...fs, f]),
            onRemove: (id) => setPendingFiles((fs) => fs.filter((f) => f.id !== id)),
          }}
        />
      </div>
    )
  }
  const [items, setItems] = useState<Row[]>([])
  // edit/view 态 items 靠 FETCH_ITEMS 异步拉取,失败/未完成前不得当"清单已被清空"处理——
  // 否则 onSubmit 会用空清单覆盖后端原值。create 态本地起手即视为就绪。
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一张发票的清单回填到当前发票
  const reqIdRef = useRef(0)
  // OCR 用图的裸文件 id:创建成功后补挂为附件,抽屉关闭即作废
  const ocrFileRef = useRef<string | null>(null)

  // 审核过账确认框:行内「审核」动作与新增后带过账日期的顺手审核共用
  const [auditDialog, setAuditDialog] = useState<{ id: string; fromCreate: boolean } | null>(null)
  const [auditDate, setAuditDate] = useState<string | null>(null)
  const [auditing, setAuditing] = useState(false)

  // 红冲确认框
  const [reverseDialog, setReverseDialog] = useState<{ id: string } | null>(null)
  const [reverseDate, setReverseDate] = useState<string | null>(null)
  const [redInvoiceNo, setRedInvoiceNo] = useState('')
  const [reversing, setReversing] = useState(false)

  // 对向发票确认框:内部公司对手,create 成功后触发
  const [mirrorAsk, setMirrorAsk] = useState<{ source: Row } | null>(null)
  const [mirroring, setMirroring] = useState(false)

  const openAudit = (row: Row, fromCreate = false) => {
    setAuditDate((row.postingDate as string | null) ?? (row.invoiceDate as string | null) ?? null)
    setAuditDialog({ id: row.id, fromCreate })
  }

  const confirmAudit = async () => {
    if (!auditDialog || !auditDate) return
    setAuditing(true)
    try {
      const data = await gqlFetch<{ auditAccVatInvoice: { errors: { message: string }[] | null } }>(
        AUDIT_INVOICE,
        { id: auditDialog.id, input: { postingDate: auditDate } }
      )
      if (data.auditAccVatInvoice.errors && data.auditAccVatInvoice.errors.length > 0) {
        throw new Error(data.auditAccVatInvoice.errors.map((e) => e.message).join('; '))
      }
      toast.success('发票已审核过账')
      setAuditDialog(null)
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'accVatInvoices'] })
    } catch (e) {
      toast.danger('审核失败', { description: (e as Error).message })
    } finally {
      setAuditing(false)
    }
  }

  const openReverse = (row: Row) => {
    setReverseDate((row.postingDate as string | null) ?? (row.invoiceDate as string | null) ?? null)
    setRedInvoiceNo('')
    setReverseDialog({ id: row.id })
  }

  const confirmReverse = async () => {
    if (!reverseDialog || !reverseDate) return
    setReversing(true)
    try {
      const data = await gqlFetch<{ reverseAccVatInvoice: { errors: { message: string }[] | null } }>(
        REVERSE_INVOICE,
        { id: reverseDialog.id, input: { postingDate: reverseDate, redInvoiceNo: redInvoiceNo || null } }
      )
      if (data.reverseAccVatInvoice.errors && data.reverseAccVatInvoice.errors.length > 0) {
        throw new Error(data.reverseAccVatInvoice.errors.map((e) => e.message).join('; '))
      }
      toast.success('发票已红冲')
      setReverseDialog(null)
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'accVatInvoices'] })
    } catch (e) {
      toast.danger('红冲失败', { description: (e as Error).message })
    } finally {
      setReversing(false)
    }
  }

  // 关闭对向发票确认框(手动放弃/确认后都会走这里);若原票已填过账日期(目前 create 表单不收
  // postingDate,此分支暂不可达,保留以对齐 journals 顺手审核惯例,字段一旦放开即时生效)则顺势弹审核
  const closeMirrorAsk = () => {
    const src = mirrorAsk?.source
    setMirrorAsk(null)
    if (src?.postingDate) {
      openAudit({ id: src.id, postingDate: src.postingDate, invoiceDate: src.invoiceDate } as Row, true)
    }
  }

  const confirmMirror = async () => {
    if (!mirrorAsk) return
    setMirroring(true)
    try {
      const input = buildMirrorInput(mirrorAsk.source)

      // 第一步:创建镜像发票。失败即整件事没发生,原票未改——照旧提示手工登记
      let mirrorId: string
      try {
        const data = await gqlFetch<{
          createAccVatInvoice: { result: { id: string } | null; errors: { message: string }[] | null }
        }>(CREATE_INVOICE, { input })
        if (data.createAccVatInvoice.errors && data.createAccVatInvoice.errors.length > 0) {
          throw new Error(data.createAccVatInvoice.errors.map((e) => e.message).join('; '))
        }
        mirrorId = data.createAccVatInvoice.result!.id
      } catch (e) {
        toast.danger('对向发票创建失败,请到对方公司手工登记', { description: (e as Error).message })
        return
      }

      // 第二步:原票回写互链。此时镜像已建成,失败不能再提示手工登记(会造成重复建票)
      try {
        const linkData = await gqlFetch<{ updateAccVatInvoice: { errors: { message: string }[] | null } }>(
          UPDATE_INVOICE,
          { id: mirrorAsk.source.id, input: { mirrorInvoiceId: mirrorId } }
        )
        if (linkData.updateAccVatInvoice.errors && linkData.updateAccVatInvoice.errors.length > 0) {
          throw new Error(linkData.updateAccVatInvoice.errors.map((e) => e.message).join('; '))
        }
        toast.success('对向发票草稿已创建并互链')
      } catch (e) {
        toast.warning('对向发票已创建,但原票互链回写失败', { description: (e as Error).message })
      }
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'accVatInvoices'] })
    } finally {
      setMirroring(false)
      closeMirrorAsk()
    }
  }

  // 打开抽屉:create 清空清单;view/edit 按发票 id 拉 items(表单字段本身走 rowId 自查完整记录,
  // 见下方 SynieRecordDrawer——表格列是白名单子集,行数据不全,不能直接传 row)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    setCreateType(null)
    setPendingFiles([])
    if (mode === 'create' || row == null) {
      setItems([])
      setItemsLoaded(true)
      return
    }
    setItemsLoaded(false)
    gqlFetch<{ accVatInvoices: { results: { items: unknown }[] } }>(FETCH_ITEMS, { id: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setItems(parseItems(d.accVatInvoices.results[0]?.items))
        setItemsLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('销售清单加载失败', { description: (e as Error).message })
        setItems([])
        setItemsLoaded(false)
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">增值税发票</h1>
      <p className="mt-2 text-sm text-ink-500">
        进销项发票登记,草稿态可自由编辑,审核后生成总账分录;支持作废、红冲与内部公司对向发票互链。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="accVatInvoices"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          attachmentImages={{ ownerType: 'acc_vat_invoice', category: 'original', label: '票面' }}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionHandlers={{
            audit: (rows) => openAudit(rows[0]),
            reverse: (rows) => openReverse(rows[0]),
          }}
        />
      </div>

      <SynieRecordDrawer
        resource="accVatInvoices"
        label="发票"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          ocrFileRef.current = null
          setDrawer(null)
          setItems([])
          setItemsLoaded(false)
        }}
        // 表格列是白名单子集(卖方/买方/金额/科目等大量字段不在其中),行数据不全;
        // 不传 row,走 rowId 自查完整记录(同 bank-accounts 先例)
        rowId={drawer?.row?.id}
        contentClassName="w-full lg:w-[880px]"
        exclude={[
          'status',
          'auditedAt',
          'auditedById',
          'createdById',
          'postingDate',
          'redInvoiceNo',
          'items',
          'insertedAt',
          'updatedAt',
        ]}
        fields={{
          companyId: {
            required: true,
            edit: 'createOnly',
            ...lay('companyId'),
            // 换公司清科目与关联对账单(均按公司+对手隔离)
            effects: () => ({
              partyAccountId: null,
              amountAccountId: null,
              taxAccountId: null,
              salReconciliationId: null,
            }),
          },
          docNo: { ...lay('docNo'), placeholder: '留空自动编号' },
          // 新增态由顶部类型选择卡写入(hidden 仍校验/提交,label 供缺失校验指名「发票类型」);
          // 编辑/查看态照常展示,方向由记录本身决定
          direction: isCreate
            ? { required: true, hidden: true, label: '发票类型', ...lay('direction') }
            : { required: true, cols: 6, ...lay('direction') },
          invoiceKind: { required: true, cols: 6, ...lay('invoiceKind'), before: ocrZone },
          invoiceDate: { cols: 6, ...lay('invoiceDate') },
          invoiceCode: { cols: 6, ...lay('invoiceCode'), placeholder: '数电票留空' },
          invoiceNo: { cols: 6, ...lay('invoiceNo'), placeholder: '草稿可留空,审核前必填' },
          issuer: { cols: 4, ...lay('issuer') },
          reviewer: { cols: 4, ...lay('reviewer') },
          payee: { cols: 4, ...lay('payee') },
          // partyType/partyId 在编辑/查看态同挂「购销双方」:标题行只随组内首个可见字段出现,
          // 不重复也不丢组;新增态 partyType 隐藏(类型选择卡写入),partyId 并入「基本信息」手工组
          partyType: isCreate
            ? { hidden: true, ...lay('partyType') }
            : {
                required: true,
                cols: 6,
                ...lay('partyType'),
                effects: () => ({ partyId: null, salReconciliationId: null }),
              },
          partyId: {
            required: true,
            cols: 6,
            ...lay('partyId'),
            visible: (v) => v.partyType != null,
            // 换对手后原关联对账单口径失效,一并清掉
            effects: () => ({ salReconciliationId: null }),
            input: ({ value, onChange, isDisabled, values }) => {
              const [resource, label] = PARTY_SOURCE[String(values.partyType)] ?? ['salCustomers', '对手']
              const companyId = (values.companyId ?? null) as string | null
              // 对手是内部公司时排除本公司自身(不能给自己开票),同 accountInput 按公司过滤写法
              const filter =
                resource === 'basCompanies' && companyId
                  ? `{id: {notEq: ${JSON.stringify(companyId)}}}`
                  : undefined
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
          buyerName: { cols: 6, ...lay('buyerName') },
          buyerTaxNo: { cols: 6, ...lay('buyerTaxNo') },
          buyerAddressPhone: { cols: 6, ...lay('buyerAddressPhone') },
          buyerBankAccount: { cols: 6, ...lay('buyerBankAccount') },
          sellerName: { cols: 6, ...lay('sellerName') },
          sellerTaxNo: { cols: 6, ...lay('sellerTaxNo') },
          sellerAddressPhone: { cols: 6, ...lay('sellerAddressPhone') },
          sellerBankAccount: { cols: 6, ...lay('sellerBankAccount') },
          netTotal: { cols: 4, ...lay('netTotal') },
          taxTotal: { cols: 4, ...lay('taxTotal') },
          grossTotal: { cols: 4, ...lay('grossTotal') },
          // 同公司、非汇总、启用科目候选(见 accountInput)
          partyAccountId: { cols: 4, ...lay('partyAccountId'), input: accountInput('往来科目') },
          amountAccountId: { cols: 4, ...lay('amountAccountId'), input: accountInput('金额科目') },
          taxAccountId: { cols: 4, ...lay('taxAccountId'), input: accountInput('税额科目') },
          // 关联销售对账单:开出发票(销售开出/内部互开)必关联,前后端同口径
          // (后端 VatInvoiceReconciliationLink);收入方向不展示(进项票无此业务),仅草稿可编辑;
          // create 态并入「基本信息」手工组(开票前先选好),edit/view 态在「关联」组
          salReconciliationId: {
            ...lay('salReconciliationId'),
            label: '关联销售对账单',
            required: true,
            visible: (v) => v.direction === 'OUTBOUND',
            input: (p) => <ReconciliationLinkInput {...p} />,
          },
          // 对向发票互链:由页面提交流程写回,不给手填;create 态恒为空,与备注一起收编在组外
          mirrorInvoiceId: { edit: 'readOnly', ...lay('mirrorInvoiceId') },
          // 备注收编在分组之外,hairline 分隔(同系统时间戳惯例)
          remarks: { ...lay('remarks') },
        }}
        onEdit={
          drawer?.row?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        // 新增先选类型:方向/对手类型随类型写入草稿(direction/partyType 创建态隐藏);
        // 编辑/查看态不显示此选择(direction 由记录本身决定)
        headerContent={(mode, _row, _values, patchValues) => {
          if (mode !== 'create') return null
          return (
            <InvoiceTypePicker
              value={createType}
              onChange={(t) => {
                if (t.preset == null) return
                setCreateType(t.key as InvoiceCreateType)
                // 换类型后对手与关联对账单口径失效,一并清掉(同 partyType/partyId effects)
                patchValues({ ...t.preset, partyId: null, salReconciliationId: null })
              }}
            />
          )
        }}
        extraContent={(mode, row, values, patchValues) => {
          // 大写显示:view 态表单草稿是空的(RecordDrawer 只在非 view 态建草稿),取行数据;
          // create/edit 态取当前表单草稿(随「从明细汇总带出」按钮实时更新)
          const gross = mode === 'view' ? row?.grossTotal : values.grossTotal
          const amountRow = (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted">价税合计(大写):</span>
              <span>{gross != null && gross !== '' ? amountInWords(gross) : '—'}</span>
              {mode !== 'view' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    const sum = (k: string) => items.reduce((acc, r) => acc + (Number(r[k]) || 0), 0)
                    const net = sum('net_amount')
                    const tax = sum('tax_amount')
                    patchValues({ netTotal: net.toFixed(2), taxTotal: tax.toFixed(2), grossTotal: (net + tax).toFixed(2) })
                  }}
                >
                  从明细汇总带出
                </Button>
              )}
            </div>
          )
          const itemsTable = (
            <SynieEditableTable
              resource="local:vatInvoiceItems"
              meta={ITEM_META}
              label="销售清单"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || !itemsLoaded}
            />
          )
          // 附件面板:create 态挂在 invoiceKind.before 的 OCR 区(带 pending 暂存);
          // 此处只服务 edit/view 态(编辑直连落库、查看只读)
          const attachmentPanel = (
            <SynieAttachmentPanel
              ownerType="acc_vat_invoice"
              ownerId={(row?.id as string | undefined) ?? null}
              category="original"
              readonly={mode === 'view'}
            />
          )
          // create 态 OCR 区(识别按钮+附件面板)已上提到「票面信息」组前(见 invoiceKind.before),
          // 此处只留 大写 → 清单(edit/view 态追加附件面板)
          return (
            <div className="flex flex-col gap-4">
              {amountRow}
              {itemsTable}
              {mode !== 'create' && attachmentPanel}
            </div>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          // edit 态 items 未就绪(FETCH_ITEMS 未回或失败)时省略 items 键,不用空清单覆盖后端原值
          const omitItems = mode === 'edit' && !itemsLoaded
          const input = omitItems ? values : { ...values, items: serializeItems(items) }
          if (mode === 'create') {
            const data = await gqlFetch<{
              createAccVatInvoice: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_INVOICE, { input })
            if (data.createAccVatInvoice.errors && data.createAccVatInvoice.errors.length > 0) {
              throw new Error(data.createAccVatInvoice.errors.map((e) => e.message).join('; '))
            }
            const createdId = data.createAccVatInvoice.result!.id
            // OCR 原图补挂为附件;挂接失败不阻断建票,提示手工补传即可
            if (ocrFileRef.current) {
              const fid = ocrFileRef.current
              ocrFileRef.current = null
              try {
                await attachFile(fid, { ownerType: 'acc_vat_invoice', ownerId: createdId, category: 'original' })
              } catch (e) {
                toast.warning('发票已创建,但票面原图挂接失败,请在附件面板手工补传', {
                  description: (e as Error).message,
                })
              }
            }
            // 暂存附件统一挂接;个别失败不阻断建票,提示手工补传(同承兑交易抽屉先例)
            if (pendingFiles.length > 0) {
              const failed: string[] = []
              for (const f of pendingFiles) {
                try {
                  await attachFile(f.id, { ownerType: 'acc_vat_invoice', ownerId: createdId, category: 'original' })
                } catch {
                  failed.push(f.filename)
                }
              }
              if (failed.length > 0) {
                toast.warning(`发票已创建,但附件挂接失败:${failed.join('、')},请在附件面板手工补传`)
              }
              setPendingFiles([])
            }
            toast.success('发票已创建')
            queryClient.invalidateQueries({ queryKey: ['gridRows', 'accVatInvoices'] })
            const source = { ...input, id: createdId } as Row
            if (values.partyType === 'COMPANY') {
              // 对手是内部公司:优先弹对向发票确认(比顺手审核优先级高)
              setMirrorAsk({ source })
            } else if (values.postingDate) {
              openAudit({ id: createdId, postingDate: values.postingDate, invoiceDate: values.invoiceDate } as Row, true)
            }
            savedId = createdId
          } else {
            const invoiceId = drawer!.row!.id
            const data = await gqlFetch<{
              updateAccVatInvoice: { errors: { message: string }[] | null }
            }>(UPDATE_INVOICE, { id: invoiceId, input })
            if (data.updateAccVatInvoice.errors && data.updateAccVatInvoice.errors.length > 0) {
              throw new Error(data.updateAccVatInvoice.errors.map((e) => e.message).join('; '))
            }
            toast.success(omitItems ? '发票已更新(销售清单未加载,本次未修改)' : '发票已更新')
            queryClient.invalidateQueries({ queryKey: ['gridRows', 'accVatInvoices'] })
            savedId = invoiceId
          }
          return savedId
        }}
      />

      <AlertDialog.Backdrop isOpen={auditDialog !== null} onOpenChange={(open) => !open && setAuditDialog(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label="审核过账">
            {auditDialog && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>
                    {auditDialog.fromCreate ? '是否直接审核过账?' : '审核过账'}
                  </AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p className="mb-3">
                    {auditDialog.fromCreate
                      ? '发票已创建并填写了过账日期,确认后立即审核并生成总账分录。'
                      : '确认后发票将审核并生成总账分录。'}
                  </p>
                  <DatePicker
                    value={safeParseDate(auditDate)}
                    onChange={(v) => setAuditDate(v ? v.toString() : null)}
                  >
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
                    {auditDialog.fromCreate ? '暂不审核' : '取消'}
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

      <AlertDialog.Backdrop isOpen={reverseDialog !== null} onOpenChange={(open) => !open && setReverseDialog(null)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" aria-label="红冲发票">
            {reverseDialog && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="danger" />
                  <AlertDialog.Heading>红冲发票</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p className="mb-3">确认后将生成红字总账分录冲销本张发票,此操作不可撤销。</p>
                  <div className="flex flex-col gap-3">
                    <DatePicker
                      value={safeParseDate(reverseDate)}
                      onChange={(v) => setReverseDate(v ? v.toString() : null)}
                    >
                      <Label>红冲过账日期</Label>
                      <DateField.Group fullWidth>
                        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
                        <DateField.Suffix>
                          <DatePicker.Trigger>
                            <DatePicker.TriggerIndicator />
                          </DatePicker.Trigger>
                        </DateField.Suffix>
                      </DateField.Group>
                      <DatePicker.Popover>
                        <Calendar aria-label="红冲过账日期">
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
                    <TextField value={redInvoiceNo} onChange={setRedInvoiceNo}>
                      <Label>红字发票号码(选填)</Label>
                      <Input placeholder="留空可后续补录" />
                    </TextField>
                  </div>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button slot="close" variant="tertiary" isDisabled={reversing}>
                    取消
                  </Button>
                  <Button variant="danger" isPending={reversing} isDisabled={!reverseDate} onPress={confirmReverse}>
                    确认红冲
                  </Button>
                </AlertDialog.Footer>
              </>
            )}
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={mirrorAsk !== null} onOpenChange={(open) => !open && closeMirrorAsk()}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]" aria-label="创建对向发票">
            {mirrorAsk && (
              <>
                <AlertDialog.Header>
                  <AlertDialog.Icon status="accent" />
                  <AlertDialog.Heading>创建对向发票?</AlertDialog.Heading>
                </AlertDialog.Header>
                <AlertDialog.Body>
                  <p>对手是内部公司,是否为其创建方向相反的对向发票草稿?(对方需自行补科目并审核)</p>
                </AlertDialog.Body>
                <AlertDialog.Footer>
                  <Button variant="tertiary" isDisabled={mirroring} onPress={closeMirrorAsk}>
                    暂不创建
                  </Button>
                  <Button isPending={mirroring} onPress={confirmMirror}>
                    创建对向发票
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
