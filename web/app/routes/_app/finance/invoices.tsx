import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
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
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { localRowId } from '~/components/synie-editable-table/editable'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
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
  const [items, setItems] = useState<Row[]>([])
  // edit/view 态 items 靠 FETCH_ITEMS 异步拉取,失败/未完成前不得当"清单已被清空"处理——
  // 否则 onSubmit 会用空清单覆盖后端原值。create 态本地起手即视为就绪。
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一张发票的清单回填到当前发票
  const reqIdRef = useRef(0)

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
      setReloadKey((k) => k + 1)
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
      setReloadKey((k) => k + 1)
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
      setReloadKey((k) => k + 1)
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
          key={reloadKey}
          resource="accVatInvoices"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
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
            order: -1,
            edit: 'createOnly',
            // 换公司清科目(科目按公司隔离)
            effects: () => ({ partyAccountId: null, amountAccountId: null, taxAccountId: null }),
          },
          docNo: { placeholder: '留空自动编号' },
          direction: { required: true, cols: 6 },
          invoiceKind: { required: true, cols: 6 },
          partyType: { required: true, cols: 6, effects: () => ({ partyId: null }) },
          partyId: {
            required: true,
            cols: 6,
            visible: (v) => v.partyType != null,
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
          invoiceCode: { cols: 6, placeholder: '数电票留空' },
          invoiceNo: { cols: 6, placeholder: '草稿可留空,审核前必填' },
          invoiceDate: { cols: 6 },
          netTotal: { cols: 4 },
          taxTotal: { cols: 4 },
          grossTotal: { cols: 4 },
          // 同公司、非汇总、启用科目候选(见 accountInput)
          partyAccountId: { cols: 4, input: accountInput('往来科目') },
          amountAccountId: { cols: 4, input: accountInput('金额科目') },
          taxAccountId: { cols: 4, input: accountInput('税额科目') },
          sellerName: { cols: 6 },
          sellerTaxNo: { cols: 6 },
          sellerAddressPhone: { cols: 6 },
          sellerBankAccount: { cols: 6 },
          buyerName: { cols: 6 },
          buyerTaxNo: { cols: 6 },
          buyerAddressPhone: { cols: 6 },
          buyerBankAccount: { cols: 6 },
          issuer: { cols: 4 },
          reviewer: { cols: 4 },
          payee: { cols: 4 },
          // 对向发票互链:由页面提交流程写回,不给手填
          mirrorInvoiceId: { edit: 'readOnly' },
        }}
        onEdit={
          drawer?.row?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          // 大写显示:view 态表单草稿是空的(RecordDrawer 只在非 view 态建草稿),取行数据;
          // create/edit 态取当前表单草稿(随「从明细汇总带出」按钮实时更新)
          const gross = mode === 'view' ? row?.grossTotal : values.grossTotal
          return (
            <div className="flex flex-col gap-4">
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
              <SynieEditableTable
                resource="local:vatInvoiceItems"
                meta={ITEM_META}
                label="销售清单"
                items={items}
                onChange={setItems}
                readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || !itemsLoaded}
              />
              <SynieAttachmentPanel
                ownerType="acc_vat_invoice"
                ownerId={(row?.id as string | undefined) ?? null}
                category="original"
                readonly={mode === 'view'}
              />
            </div>
          )
        }}
        onSubmit={async (values, mode) => {
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
            toast.success('发票已创建')
            setReloadKey((k) => k + 1)
            const source = { ...input, id: createdId } as Row
            if (values.partyType === 'COMPANY') {
              // 对手是内部公司:优先弹对向发票确认(比顺手审核优先级高)
              setMirrorAsk({ source })
            } else if (values.postingDate) {
              openAudit({ id: createdId, postingDate: values.postingDate, invoiceDate: values.invoiceDate } as Row, true)
            }
          } else {
            const invoiceId = drawer!.row!.id
            const data = await gqlFetch<{
              updateAccVatInvoice: { errors: { message: string }[] | null }
            }>(UPDATE_INVOICE, { id: invoiceId, input })
            if (data.updateAccVatInvoice.errors && data.updateAccVatInvoice.errors.length > 0) {
              throw new Error(data.updateAccVatInvoice.errors.map((e) => e.message).join('; '))
            }
            toast.success(omitItems ? '发票已更新(销售清单未加载,本次未修改)' : '发票已更新')
            setReloadKey((k) => k + 1)
          }
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
