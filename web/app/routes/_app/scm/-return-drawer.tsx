/**
 * 退货单抽屉三侧共享实现（销售 / 采购 / 委外）。
 * 管道与条目骨架一份；侧差收在 ReturnDrawerKind 规格（资源、源单锚点、金额/纯数量、补货）。
 * 分侧路由文件只做 createReturnDrawer(kind) 薄包装，保持 ./ -return-drawer 导入稳定、open 桥分侧隔离。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Label, NumberField, TextField, toast } from '@heroui/react'
import { Link } from '@tanstack/react-router'
import {
  headerFieldErrors,
  rowErrors,
} from '~/lib/resources/sales-delivery-draft'
import {
  buildPurchaseOutsourcedReturnDraft,
  buildPurchaseReturnDraft,
  buildReturnDraft,
  type ReturnDraftIndex,
} from '~/lib/resources/return-draft'
import { APIError } from '~/lib/api/client'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import type { AggregateDraftAdapter } from '~/lib/resources/catalog/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { generateSalesReturnReplenishment } from '~/lib/resources/returns'
import { demandClient } from '~/lib/resources/manufacturing'
import { useResourceCapabilities } from '~/lib/use-resource-capabilities'
import { toastError } from '~/lib/toast'
import { auditMaterialCell, type AuditDocConfig } from './-audit-doc'
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from './-stock-doc'
import { fetchCompanyAccountDefaults } from '~/components/company-account-defaults'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { todayLocal, useAuthorizedCompanies } from '~/lib/form-defaults'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

export type ReturnDrawerKind = 'sales' | 'purchase' | 'outsourced'

export interface ReturnRef {
  id: string
  status?: unknown
}

export type OpenReturnDrawer = (mode: DrawerMode, doc: ReturnRef | null) => void

type ReturnSavedDraft = Row & { items: Row[] }

type AccountDefaults = Awaited<ReturnType<typeof fetchCompanyAccountDefaults>>

type SourceItemIdField = 'deliveryItemId' | 'receiptItemId' | 'outsourcedReceiptItemId'

interface AccountSlot {
  label: string
  placeholderReady: string
  role?: string
}

interface ReturnDrawerSpec {
  kind: ReturnDrawerKind
  resource: 'salReturns' | 'purReturns' | 'purOutsourcedReturns'
  itemsResource: string
  sourceItemsResource: string
  sourceItemIdField: SourceItemIdField
  sourceStatusField: 'deliveryStatus' | 'receiptStatus'
  sourceDateField: 'deliveryDate' | 'receiptDate'
  sourceNoField: 'deliveryNo' | 'receiptNo'
  sourceItemNoun: string
  sourceDocNoun: string
  drawingOwnerType: string
  warehouseLabel: string
  monetary: boolean
  replenishment: boolean
  docLabel: string
  writerGuard: string
  invalidateResources: string[]
  extraSourceFilter?: FilterState
  sourceDateLabel: string
  sourceNoLabel: string
  sourceQtyLabel: string
  buildDraft: (
    values: Record<string, unknown>,
    items: Row[],
  ) => { draft: unknown; index: ReturnDraftIndex }
  accountMap?: (row: AccountDefaults) => {
    debitAccountId: string | null
    creditAccountId: string | null
  }
  debit?: AccountSlot
  credit?: AccountSlot
}

function specFor(kind: ReturnDrawerKind): ReturnDrawerSpec {
  if (kind === 'sales') {
    return {
      kind,
      resource: 'salReturns',
      itemsResource: 'salReturnItems',
      sourceItemsResource: 'salDeliveryItems',
      sourceItemIdField: 'deliveryItemId',
      sourceStatusField: 'deliveryStatus',
      sourceDateField: 'deliveryDate',
      sourceNoField: 'deliveryNo',
      sourceItemNoun: '发货条目',
      sourceDocNoun: '发货单',
      drawingOwnerType: 'sal_return_item',
      warehouseLabel: '退货入仓',
      monetary: true,
      replenishment: true,
      docLabel: '销售退货单',
      writerGuard: '销售退货表单不得暴露 RecordWriter create/update',
      invalidateResources: ['salReturnItems', 'salDeliveryItems', 'salOrderItems'],
      sourceDateLabel: '发货日期',
      sourceNoLabel: '发货单号',
      sourceQtyLabel: '发货数量',
      buildDraft: buildReturnDraft,
      accountMap: (row) => ({
        // 退货 = 发货反转:借方代入发货贷方槽,贷方(未开票应收)代入发货借方槽
        debitAccountId: row?.deliveryCreditAccountId ?? null,
        creditAccountId: row?.deliveryDebitAccountId ?? null,
      }),
      debit: { label: '借方科目', placeholderReady: '选择借方科目(存货/费用等)…' },
      credit: {
        label: '贷方科目(未开票应收)',
        placeholderReady: '选择未开票应收科目…',
        role: 'UNBILLED_RECEIVABLE',
      },
    }
  }
  if (kind === 'purchase') {
    return {
      kind,
      resource: 'purReturns',
      itemsResource: 'purReturnItems',
      sourceItemsResource: 'purReceiptItems',
      sourceItemIdField: 'receiptItemId',
      sourceStatusField: 'receiptStatus',
      sourceDateField: 'receiptDate',
      sourceNoField: 'receiptNo',
      sourceItemNoun: '入库条目',
      sourceDocNoun: '入库单',
      drawingOwnerType: 'pur_return_item',
      warehouseLabel: '退货出仓',
      monetary: true,
      replenishment: false,
      docLabel: '采购退货单',
      writerGuard: '采购退货表单不得暴露 RecordWriter create/update',
      invalidateResources: ['purReturnItems', 'purReceiptItems', 'purOrderItems'],
      sourceDateLabel: '入库日期',
      sourceNoLabel: '入库单号',
      sourceQtyLabel: '入库数量',
      buildDraft: buildPurchaseReturnDraft,
      accountMap: (row) => ({
        // 退货 = 入库反转:借方(未开票应付)代入入库贷方槽,贷方代入入库借方槽
        debitAccountId: row?.receiptCreditAccountId ?? null,
        creditAccountId: row?.receiptDebitAccountId ?? null,
      }),
      debit: {
        label: '借方科目(未开票应付)',
        placeholderReady: '选择未开票应付科目…',
        role: 'UNBILLED_PAYABLE',
      },
      credit: { label: '贷方科目', placeholderReady: '选择贷方科目…' },
    }
  }
  return {
    kind,
    resource: 'purOutsourcedReturns',
    itemsResource: 'purOutsourcedReturnItems',
    sourceItemsResource: 'purOutsourcedReceiptItems',
    sourceItemIdField: 'outsourcedReceiptItemId',
    sourceStatusField: 'receiptStatus',
    sourceDateField: 'receiptDate',
    sourceNoField: 'receiptNo',
    sourceItemNoun: '委外入库条目',
    sourceDocNoun: '委外入库单',
    drawingOwnerType: 'pur_outsourced_return_item',
    warehouseLabel: '退货出仓',
    monetary: false,
    replenishment: false,
    docLabel: '委外退货单',
    writerGuard: '委外退货表单不得暴露 RecordWriter create/update',
    invalidateResources: [
      'purOutsourcedReturnItems',
      'purOutsourcedReceiptItems',
      'purOrderItems',
    ],
    extraSourceFilter: {
      // 委外定案：已对账数量 > 0 的委外入库条目禁止退货（加工费只对账一次）
      reconciledQty: { kind: 'number', op: 'eq', value: '0' },
    },
    sourceDateLabel: '委外入库日期',
    // 既有文案（采购侧复制残留的叠词），抽取时保持原样
    sourceNoLabel: '委外委外入库单号',
    sourceQtyLabel: '委外入库数量',
    buildDraft: buildPurchaseOutsourcedReturnDraft,
  }
}

/**
 * 科目候选使用结构化 REST FilterState。
 */
function accountFilter(companyId: string | null, roleEnum?: string): FilterState | undefined {
  if (!companyId) return undefined
  return {
    companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
    isGroup: { kind: 'bool', eq: false },
    active: { kind: 'bool', eq: true },
    ...(roleEnum ? { role: { kind: 'enum' as const, values: [roleEnum] } } : {}),
  }
}

/**
 * 新建态:公司选定/变更时整组覆盖借贷科目为该公司默认(履约槽反转代入;
 * 无默认则清空)。编辑态公司锁死,不重灌。
 */
function ReturnAccountDefaultSync({
  mode,
  companyId,
  patchValues,
  mapDefaults,
}: {
  mode: DrawerMode
  companyId: string | null
  patchValues: (patch: Record<string, unknown>) => void
  mapDefaults: NonNullable<ReturnDrawerSpec['accountMap']>
}) {
  const filledFor = useRef<string | null>(null)

  useEffect(() => {
    if (mode !== 'create') return
    if (!companyId) {
      filledFor.current = null
      return
    }
    if (filledFor.current === companyId) return
    filledFor.current = companyId
    let cancelled = false
    void fetchCompanyAccountDefaults(companyId).then((row) => {
      if (cancelled) return
      patchValues(mapDefaults(row))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, companyId])

  return null
}

function ReturnAccountFooter({
  mode,
  values,
  patchValues,
  isDisabled,
  fieldErrors,
  debit,
  credit,
}: {
  mode: DrawerMode
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  isDisabled: boolean
  fieldErrors?: Record<string, string[]>
  debit: AccountSlot
  credit: AccountSlot
}) {
  const companyId = (values.companyId as string | null) ?? null
  const debitId = values.debitAccountId == null || values.debitAccountId === '' ? null : String(values.debitAccountId)
  const creditId =
    values.creditAccountId == null || values.creditAccountId === '' ? null : String(values.creditAccountId)

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t border-separator pt-4 lg:grid-cols-2">
      <div>
        <RemoteSelect
          resource="basAccounts"
          label={debit.label}
          placeholder={companyId ? debit.placeholderReady : '先选择公司'}
          value={debitId}
          onChange={(id) => patchValues({ debitAccountId: id })}
          isDisabled={isDisabled || !companyId || mode === 'view'}
          isRequired={mode !== 'view'}
          filterState={accountFilter(companyId, debit.role)}
          labelField="name"
          searchFields={['name', 'code']}
          itemSubtitleFields={['code']}
        />
        {fieldErrors?.debitAccountId?.length ? (
          <p className="mt-1 text-xs text-danger" role="alert">
            {fieldErrors.debitAccountId.join('；')}
          </p>
        ) : null}
      </div>
      <div>
        <RemoteSelect
          resource="basAccounts"
          label={credit.label}
          placeholder={companyId ? credit.placeholderReady : '先选择公司'}
          value={creditId}
          onChange={(id) => patchValues({ creditAccountId: id })}
          isDisabled={isDisabled || !companyId || mode === 'view'}
          isRequired={mode !== 'view'}
          filterState={accountFilter(companyId, credit.role)}
          labelField="name"
          searchFields={['name', 'code']}
          itemSubtitleFields={['code']}
        />
        {fieldErrors?.creditAccountId?.length ? (
          <p className="mt-1 text-xs text-danger" role="alert">
            {fieldErrors.creditAccountId.join('；')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function sourceItemGridFilter(
  spec: ReturnDrawerSpec,
  values: Record<string, unknown>,
): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  return {
    [spec.sourceStatusField]: { kind: 'enum', values: ['AUDITED'] },
    companyId: { kind: 'fk', op: 'in', values: [String(companyId)], labels: [] },
    partyType: { kind: 'enum', values: [String(partyType)] },
    partyId: {
      kind: 'polyFk',
      op: 'in',
      variant: String(partyType),
      values: [String(partyId)],
      labels: [],
    },
    remainingReturnableQty: { kind: 'number', op: 'gt', value: '0' },
    ...spec.extraSourceFilter,
  }
}

function sourceItemDisplay(spec: ReturnDrawerSpec, r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining = r.remainingReturnableQty != null ? String(r.remainingReturnableQty) : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem = remaining != null ? `可退${remaining}${unit ? unit : ''}` : ''
  return [material || spec.sourceItemNoun, rem].filter(Boolean).join(' · ')
}

/** 只读文本字段(物料/单位锁定回显) */
function LockedText({ label, value }: { label: string; value: string }) {
  return (
    <TextField isDisabled value={value || '—'}>
      <Label>{label}</Label>
      <Input />
    </TextField>
  )
}

/**
 * 新建态:公司选定后按公司本币代入原币与汇率 1(含手工行时的全单换算口径)。
 * 编辑态公司锁死,不重灌。
 */
function ReturnCurrencyDefaultSync({
  mode,
  companyId,
  currencyId,
  companies,
  patchValues,
}: {
  mode: DrawerMode
  companyId: string | null
  currencyId: string | null
  companies: Row[]
  patchValues: (patch: Record<string, unknown>) => void
}) {
  useEffect(() => {
    if (mode !== 'create' || !companyId || currencyId) return
    const company = companies.find((c) => String(c.id) === companyId)
    const base = company?.baseCurrencyId
    if (base != null && base !== '') {
      patchValues({ currencyId: String(base), exchangeRate: '1' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, companyId, currencyId, companies])
  return null
}

function isManualItem(vals: Record<string, unknown>, field: SourceItemIdField): boolean {
  return vals[field] == null || vals[field] === ''
}

/**
 * 「生成补货需求单」按钮 + 已生成需求单链接（已审核单查看态）。
 * 可重复点击，每次生成一张新草稿；重复生成的超量由需求单确认时占用校验兜底。
 */
function ReplenishmentPanel({
  row,
  queryClient,
  invalidate,
}: {
  row: Row
  queryClient: ReturnType<typeof useQueryClient>
  invalidate: () => void
}) {
  const [busy, setBusy] = useState(false)
  const canCreateDemand = useResourceCapabilities('mfgDemands').has('create')
  const generated = useQuery({
    queryKey: ['returnReplenishments', String(row.id)],
    enabled: row.id != null,
    queryFn: () =>
      demandClient
        .query({
          limit: 50,
          offset: 0,
          filter: {
            sourceReturnId: { kind: 'fk', op: 'in', values: [String(row.id)], labels: [] },
          },
          sort: { column: 'insertedAt', direction: 'descending' },
        })
        .then((r) => r.results),
  })

  const run = async () => {
    setBusy(true)
    try {
      const result = await generateSalesReturnReplenishment(String(row.id))
      toast.success(`已生成补货需求单 ${result.demandNo}`)
      await Promise.all([
        resourceBindingFor('mfgDemands').cache.invalidateGrid(queryClient),
        resourceBindingFor('mfgDemandItems').cache.invalidateGrid(queryClient),
      ])
      invalidate()
      generated.refetch()
    } catch (e) {
      toastError('生成补货需求单失败')(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-separator pt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">补货需求单</span>
        {canCreateDemand && (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy}
            isPending={busy}
            onPress={() => void run()}
          >
            生成补货需求单
          </Button>
        )}
      </div>
      {(generated.data ?? []).length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-sm text-muted">
          {(generated.data ?? []).map((d) => (
            <li key={String(d.id)}>
              <Link
                to="/mfg/demands"
                search={{ record: String(d.id), mode: 'view' }}
                className="text-accent hover:underline"
              >
                {String(d.demandNo)}
              </Link>
              <span className="ml-2 text-xs">
                {d.status === 'DRAFT' ? '草稿' : d.status === 'CONFIRMED' ? '已确认' : String(d.status)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">尚未生成；点击按钮把全部退货行转成一张履约需求单草稿</p>
      )}
    </div>
  )
}

/**
 * 头关键字段变更清行(ItemsResetGuard)的指纹字段:公司/对手类型/对手任一变则清空条目草稿。
 */
const ITEMS_RESET_FIELDS = ['companyId', 'partyType', 'partyId'] as const

const MONETARY_EXCLUDE = [
  'returnId',
  'companyId',
  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
  'returnNo',
  'returnDate',
  'returnStatus',
  'partyType',
  'partyId',
  // 订单快照不进表单(物料/单位快照名走只读字段展示;价税对手工行是录入字段)
  'orderQty',
  'orderBaseQty',
  'orderUnitName',
  'orderAmount',
  'orderBasePrice',
  'orderBaseAmount',
  'orderCurrencyCode',
  'orderNo',
  'reconciledQty',
  'remainingReconcilableQty',
] as const

const QTY_ONLY_EXCLUDE = [
  'returnId',
  'companyId',
  'returnNo',
  'returnDate',
  'returnStatus',
  'partyType',
  'partyId',
  'orderQty',
  'orderBaseQty',
  'orderUnitName',
  'orderNo',
] as const

/**
 * 按侧生成退货抽屉模块。必须在模块顶层调用一次（内部 createDocumentDrawerOpenBridge），
 * 使销售/采购/委外各持独立 open 桥，与原先三分文件行为一致。
 */
export function createReturnDrawer(kind: ReturnDrawerKind) {
  const spec = specFor(kind)
  const binding = resourceBindingFor(spec.resource)
  const draftApi = aggregateDraftFor(spec.resource) as AggregateDraftAdapter<
    unknown,
    ReturnSavedDraft
  >

  async function loadReturnItemsForAudit(returnId: string): Promise<Row[]> {
    return (await draftApi.loadDraft(returnId)).items
  }

  const returnAuditConfig = {
    docLabel: spec.docLabel,
    resource: spec.resource,
    commandKey: 'audit',
    itemsResource: spec.itemsResource,
    columns: [
      {
        key: 'materialName',
        label: '物料',
        render: auditMaterialCell({ drawingOwnerType: spec.drawingOwnerType }),
      },
      { key: 'unitName', label: '单位' },
      { key: 'qty', label: '退货数量', align: 'end' },
      { key: 'baseQty', label: '折算数量', align: 'end' },
      { key: 'remarks', label: '行备注' },
    ],
    loadItems: loadReturnItemsForAudit,
  } satisfies AuditDocConfig

  const {
    useOpen: useReturnDrawer,
    Provider: ReturnDrawerOpenProvider,
  } = createDocumentDrawerOpenBridge<OpenReturnDrawer>()

  function ReturnDrawerProvider({
    children,
    urlSync = false,
  }: {
    children: ReactNode
    urlSync?: boolean
  }) {
    const sourceItemsRef = useRef(new Map<string, Row>())
    const manualMaterialsRef = useRef(new Map<string, Row>())
    const draftHeadRef = useRef<Record<string, unknown>>({})
    const savedDraftsRef = useRef(new Map<string, ReturnSavedDraft>())
    const drawer = useDocumentDrawer<ReturnSavedDraft>({
      resource: spec.resource,
      urlSync,
      loadDraft: (id) => {
        const cached = savedDraftsRef.current.get(id)
        if (cached) {
          savedDraftsRef.current.delete(id)
          return Promise.resolve(cached)
        }
        return draftApi.loadDraft(id)
      },
    })
    const { isOpen, mode, rowId } = drawer
    const [items, setItems] = useState<Row[]>([])
    const [draftErrors, setDraftErrors] = useState<Record<string, string[]>>({})
    const [draftErrorIndex, setDraftErrorIndex] = useState<ReturnDraftIndex | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [filters] = useState<FilterState>({})
    const queryClient = useQueryClient()
    const returnStatus = drawer.draft?.status ?? drawer.row?.status

    const companies = useAuthorizedCompanies()
    const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

    const resetItems = useCallback(() => {
      setDraftErrors({})
      setItems((cur) => (cur.length === 0 ? cur : []))
    }, [])

    useEffect(() => {
      const saved = drawer.draft
      draftHeadRef.current = saved ?? {}
      const itemRows = saved?.items ?? []
      const cache = new Map<string, Row>()
      for (const r of itemRows) {
        const sourceId = r[spec.sourceItemIdField]
        if (sourceId != null) {
          cache.set(String(sourceId), {
            id: String(sourceId),
            materialId: r.materialId,
            unitId: r.unitId,
            materialCode: r.materialCode,
            materialName: r.materialName,
            materialSpec: r.materialSpec,
            customerPartNo: r.customerPartNo,
            unitName: r.unitName,
            orderNo: r.orderNo,
          } as Row)
        }
      }
      sourceItemsRef.current = cache
      setDraftErrors({})
      setItems(itemRows)
    }, [drawer.draft, drawer.generation])

    const openDrawer: OpenReturnDrawer = (nextMode, doc) => {
      drawer.open(nextMode, doc)
    }

    const acceptSavedDraft = (saved: ReturnSavedDraft) => {
      setDraftErrors({})
      setDraftErrorIndex(null)
      savedDraftsRef.current.set(String(saved.id), saved)
      drawer.open('edit', saved)
    }

    const fieldErrors = headerFieldErrors(draftErrors)
    const itemErrors = rowErrors(
      draftErrors,
      /^items\[(\d+)\](?:\.(.+))?$/,
      (itemIndex) => {
        const id = draftErrorIndex?.itemRowIds[itemIndex]
        return id == null ? undefined : items.find((row) => String(row.id) === id)
      },
    )
    const baseCfg = drawerConfig(spec.resource)
    const drawerCfg = {
      ...baseCfg,
      fields: {
        ...baseCfg.fields,
        companyId: {
          ...baseCfg.fields?.companyId,
          required: true,
          order: -1,
          edit: 'createOnly' as const,
          defaultValue: createDefaultCompany,
          effects: () =>
            spec.monetary
              ? { warehouseId: null, debitAccountId: null, creditAccountId: null }
              : { warehouseId: null },
        },
        returnDate: { ...baseCfg.fields?.returnDate, defaultValue: todayLocal() },
        ...(spec.monetary
          ? {
              currencyId: {
                ...baseCfg.fields?.currencyId,
                input: ({
                  value,
                  onChange,
                  isDisabled,
                }: {
                  value: unknown
                  onChange: (v: unknown) => void
                  isDisabled: boolean
                }) => (
                  <RemoteSelect
                    resource="basCurrencies"
                    label="原币(含手工行时全单换算口径;有行后锁改)"
                    value={value == null || value === '' ? null : String(value)}
                    onChange={onChange}
                    isDisabled={isDisabled || items.length > 0}
                    filterState={{ active: { kind: 'bool', eq: true } }}
                    labelField="name"
                    searchFields={['name', 'isoCode']}
                    itemSubtitleFields={['isoCode']}
                  />
                ),
              },
              exchangeRate: { ...baseCfg.fields?.exchangeRate, defaultValue: '1' },
            }
          : {}),
        warehouseId: {
          ...baseCfg.fields?.warehouseId,
          input: ({
            value,
            onChange,
            isDisabled,
            values,
          }: {
            value: unknown
            onChange: (v: unknown) => void
            isDisabled: boolean
            values: Record<string, unknown>
          }) => (
            <WarehouseRemoteSelect
              value={value}
              onChange={onChange}
              isDisabled={isDisabled}
              companyId={(values.companyId as string | null) ?? null}
              label="默认仓库(可空,仅新建行预填)"
            />
          ),
        },
      },
    }

    return (
      <ReturnDrawerOpenProvider value={openDrawer}>
        {children}
        <SynieRecordDrawer
          resource={spec.resource}
          {...drawerCfg}
          mode={mode}
          isOpen={isOpen}
          isSubmitDisabled={mode === 'edit' && !drawer.detailLoaded}
          onOpenChange={(open) => {
            if (open) return
            drawer.close()
            setDraftErrors({})
          }}
          rowId={rowId}
          row={drawer.draft}
          fieldErrors={fieldErrors}
          keepOpenOnAuditFailure
          footerActions={
            spec.replenishment
              ? (footerMode, row) =>
                  footerMode === 'view' && row?.status === 'AUDITED' ? (
                    <ReplenishmentPanel
                      row={row}
                      queryClient={queryClient}
                      invalidate={() => void binding.cache.invalidateGrid(queryClient)}
                    />
                  ) : null
              : undefined
          }
          onEdit={
            returnStatus === 'DRAFT' ? () => drawer.setMode('edit') : undefined
          }
          extraContent={(mode, row, values, patchValues) => {
            draftHeadRef.current = values
            const companyId = (values.companyId as string | null) ?? null
            const headWarehouse = values.warehouseId
            const headerReady = Boolean(values.companyId && values.partyType && values.partyId)
            const diGridFilter = sourceItemGridFilter(spec, values)
            const sourceField = spec.sourceItemIdField

            const itemFields: Record<string, FieldOverride> = {
              idx: { visible: () => false },
              [sourceField]: {
                order: 0,
                section: `方式一:从${spec.sourceDocNoun}导入(源单行)`,
                label: `${spec.sourceItemNoun}(留空保存即为手工行)`,
                input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                  <RemoteDialogSelect
                    resource={spec.sourceItemsResource}
                    label={spec.sourceItemNoun}
                    dialogTitle={`选择可退货${spec.sourceItemNoun}`}
                    placeholder={
                      diGridFilter
                        ? `点击选择${spec.sourceItemNoun};留空则按下方手工填写建行…`
                        : '先选齐公司与对手'
                    }
                    labelField="materialName"
                    fields={[
                      'materialCode',
                      'materialName',
                      'materialSpec',
                      'customerPartNo',
                      'unitName',
                      'materialId',
                      'unitId',
                      'qty',
                      'baseQty',
                      'returnedQty',
                      'remainingReturnableQty',
                      spec.sourceDateField,
                      spec.sourceNoField,
                      'orderNo',
                    ]}
                    value={value == null ? null : String(value)}
                    onChange={(id, ditem) => {
                      if (id && ditem) sourceItemsRef.current.set(String(id), ditem)
                      onChange(id)
                      patchItem({
                        materialId: ditem?.materialId ?? null,
                        unitId: ditem?.unitId ?? null,
                        materialCode: ditem?.materialCode ?? null,
                        materialName: ditem?.materialName ?? null,
                        materialSpec: ditem?.materialSpec ?? null,
                        customerPartNo: ditem?.customerPartNo ?? null,
                        unitName: ditem?.unitName ?? null,
                        orderNo: ditem?.orderNo ?? null,
                      })
                    }}
                    isDisabled={isDisabled || diGridFilter == null}
                    gridFilter={diGridFilter ?? undefined}
                    gridColumns={[
                      spec.sourceDateField,
                      spec.sourceNoField,
                      'orderNo',
                      'materialCode',
                      'materialName',
                      'materialSpec',
                      'customerPartNo',
                      'unitName',
                      'baseQty',
                      'returnedQty',
                      'remainingReturnableQty',
                    ]}
                    gridOverrides={{
                      [spec.sourceDateField]: { label: spec.sourceDateLabel },
                      [spec.sourceNoField]: { label: spec.sourceNoLabel },
                      orderNo: { label: '订单号' },
                      materialCode: { label: '物料编号' },
                      materialName: { label: '物料名称' },
                      materialSpec: { label: '规格' },
                      customerPartNo: { label: '客户料号' },
                      unitName: { label: '单位' },
                      baseQty: { label: spec.sourceQtyLabel },
                      returnedQty: { label: '已退数量' },
                      remainingReturnableQty: { label: '剩余可退' },
                    }}
                    gridDefaultSort={{ column: spec.sourceDateField, direction: 'descending' }}
                    gridExtraFields={['materialId', 'unitId']}
                    dialogClassName="max-w-5xl"
                    renderValue={(r) => sourceItemDisplay(spec, r)}
                  />
                ),
              },
              materialId: {
                order: 1,
                section: '方式二:手工加行(无源单历史退货)',
                label: '物料',
                required: true,
                visible: (v) => isManualItem(v, sourceField),
                input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                  <RemoteDialogSelect
                    resource="invMaterials"
                    label="物料"
                    dialogTitle="选择物料"
                    placeholder="点击选择物料…"
                    labelField="name"
                    fields={['code', 'name', 'spec', 'customerPartNo', 'defaultUnitId']}
                    value={value == null ? null : String(value)}
                    onChange={(id, material) => {
                      if (id && material) manualMaterialsRef.current.set(String(id), material)
                      onChange(id)
                      patchItem({
                        materialCode: material?.code ?? null,
                        materialName: material?.name ?? null,
                        materialSpec: material?.spec ?? null,
                        customerPartNo: material?.customerPartNo ?? null,
                        unitId: null,
                        unitName: null,
                      })
                    }}
                    isDisabled={isDisabled}
                    isRequired
                    gridColumns={['code', 'name', 'spec', 'customerPartNo']}
                    gridOverrides={{
                      code: { label: '物料编号' },
                      name: { label: '物料名称' },
                      spec: { label: '规格' },
                      customerPartNo: { label: '客户料号' },
                    }}
                    gridFilter={{ active: { kind: 'bool', eq: true } }}
                    dialogClassName="max-w-3xl"
                    renderValue={(r) =>
                      [r.materialCode ?? r.code, r.materialName ?? r.name]
                        .filter((x) => x != null && x !== '')
                        .join(' ') || '物料'
                    }
                  />
                ),
              },
              unitId: {
                order: 2,
                cols: 6,
                required: true,
                label: '单位',
                visible: (v) => isManualItem(v, sourceField),
                input: ({ value, onChange, isDisabled, values: lv }) => (
                  <MaterialUnitSelect
                    materialId={lv.materialId == null ? null : String(lv.materialId)}
                    value={value}
                    onChange={onChange}
                    isDisabled={isDisabled}
                  />
                ),
              },
              ...(spec.monetary
                ? {
                    orderPrice: {
                      order: 3,
                      cols: 6,
                      required: true,
                      label: '含税单价(原币)',
                      visible: (v: Record<string, unknown>) => isManualItem(v, sourceField),
                    },
                    orderTaxRate: {
                      order: 4,
                      cols: 6,
                      required: true,
                      label: '税率',
                      visible: (v: Record<string, unknown>) => isManualItem(v, sourceField),
                    },
                  }
                : {}),
              materialName: {
                order: 1,
                label: '物料',
                visible: (v) => !isManualItem(v, sourceField),
                input: ({ values: iv }) => {
                  const code = iv.materialCode != null ? String(iv.materialCode) : ''
                  const name = iv.materialName != null ? String(iv.materialName) : ''
                  const text =
                    [code, name].filter(Boolean).join(' ') || `选${spec.sourceItemNoun}后自动带出`
                  return <LockedText label="物料" value={text} />
                },
              },
              materialSpec: {
                order: 2,
                cols: 6,
                label: '规格',
                visible: (v) => !isManualItem(v, sourceField),
                input: ({ values: iv }) => (
                  <LockedText
                    label="规格"
                    value={iv.materialSpec != null ? String(iv.materialSpec) : '—'}
                  />
                ),
              },
              customerPartNo: {
                order: 3,
                cols: 6,
                label: '客户料号',
                visible: (v) => !isManualItem(v, sourceField),
                input: ({ values: iv }) => (
                  <LockedText
                    label="客户料号"
                    value={iv.customerPartNo != null ? String(iv.customerPartNo) : '—'}
                  />
                ),
              },
              unitName: {
                order: 4,
                cols: 6,
                label: '单位',
                visible: (v) => !isManualItem(v, sourceField),
                input: ({ values: iv }) => (
                  <LockedText
                    label="单位"
                    value={
                      iv.unitName != null ? String(iv.unitName) : `选${spec.sourceItemNoun}后自动带出`
                    }
                  />
                ),
              },
              qty: { order: 5, cols: 6, required: true, label: '退货数量' },
              warehouseId: {
                order: 6,
                required: true,
                label: spec.warehouseLabel,
                defaultValue:
                  headWarehouse == null || headWarehouse === '' ? null : String(headWarehouse),
                input: ({ value, onChange, isDisabled }) => (
                  <WarehouseRemoteSelect
                    value={value}
                    onChange={onChange}
                    isDisabled={isDisabled}
                    companyId={companyId}
                    label={spec.warehouseLabel}
                  />
                ),
              },
              baseQty: {
                order: 7,
                cols: 6,
                label: '折算数量',
                input: ({ value }) => (
                  <NumberField
                    fullWidth
                    isDisabled
                    value={value == null || value === '' ? NaN : Number(value)}
                  >
                    <Label>折算数量(默认单位)</Label>
                    <NumberField.Group className="grid-cols-[1fr]">
                      <NumberField.Input placeholder="保存后系统折算" />
                    </NumberField.Group>
                  </NumberField>
                ),
              },
              remarks: { order: 8, label: '行备注' },
              materialCode: { visible: () => false },
              orderItemId: { visible: () => false },
            }

            return (
              <>
                <CompanyDefaultSync
                  mode={mode}
                  values={values}
                  patchValues={patchValues}
                  defaultId={createDefaultCompany}
                />
                {spec.accountMap && spec.debit && spec.credit ? (
                  <ReturnAccountDefaultSync
                    key={`acct-${rowId ?? 'create'}-${drawer.generation}`}
                    mode={mode}
                    companyId={companyId}
                    patchValues={patchValues}
                    mapDefaults={spec.accountMap}
                  />
                ) : null}
                {spec.monetary ? (
                  <ReturnCurrencyDefaultSync
                    mode={mode}
                    companyId={companyId}
                    currencyId={(values.currencyId as string | null) ?? null}
                    companies={companies.data ?? []}
                    patchValues={patchValues}
                  />
                ) : null}
                <ItemsResetGuard
                  key={`${rowId ?? 'create'}-${drawer.generation}`}
                  mode={mode}
                  row={row}
                  values={values}
                  fields={ITEMS_RESET_FIELDS}
                  onReset={resetItems}
                />
                <SynieEditableTable
                  resource={spec.itemsResource}
                  label="退货条目"
                  items={items}
                  rowErrors={itemErrors}
                  onChange={(rows) => {
                    setDraftErrors({})
                    setItems(rows)
                  }}
                  readOnly={
                    submitting ||
                    mode === 'view' ||
                    (row != null && row.status !== 'DRAFT') ||
                    (mode !== 'create' && !drawer.detailLoaded)
                  }
                  canCreate={headerReady}
                  toolbar={
                    mode === 'view' || (row != null && row.status !== 'DRAFT') ? undefined : !headerReady ? (
                      <span className="text-xs text-muted">先选齐公司、对手类型与对手</span>
                    ) : undefined
                  }
                  drawerClassName="w-full lg:w-[560px]"
                  exclude={[...(spec.monetary ? MONETARY_EXCLUDE : QTY_ONLY_EXCLUDE)]}
                  columns={[
                    'idx',
                    sourceField,
                    'materialName',
                    'unitName',
                    'qty',
                    ...(spec.monetary ? (['orderPrice', 'orderTaxRate'] as const) : []),
                    'warehouseId',
                    'baseQty',
                    'remarks',
                  ]}
                  overrides={{
                    [sourceField]: {
                      label: '来源订单',
                      render: (_v: unknown, r: Row) =>
                        r.orderNo != null && r.orderNo !== ''
                          ? String(r.orderNo)
                          : r[sourceField] == null || r[sourceField] === ''
                            ? '手工行'
                            : undefined,
                    },
                    ...(spec.monetary
                      ? {
                          orderPrice: { label: '含税单价' },
                          orderTaxRate: { label: '税率' },
                        }
                      : {}),
                    materialName: {
                      label: '物料',
                      className: 'min-w-[12rem] max-w-[18rem]',
                      render: materialCellRender({ drawingOwnerType: spec.drawingOwnerType }),
                    },
                    unitName: { label: '单位' },
                    baseQty: { label: '折算数量' },
                    remarks: { label: '行备注' },
                  }}
                  fields={itemFields}
                  validateItem={(vals, _items, editing) => {
                    if (isManualItem(vals, sourceField)) {
                      if (!vals.materialId) return '请选择物料'
                      if (!vals.unitId) return '请选择单位'
                      if (spec.monetary) {
                        if (vals.orderPrice == null || vals.orderPrice === '') return '请填写含税单价'
                        if (Number(vals.orderPrice) < 0) return '含税单价不能小于 0'
                        if (vals.orderTaxRate == null || vals.orderTaxRate === '') return '请填写税率'
                        if (Number(vals.orderTaxRate) < 0) return '税率不能小于 0'
                      }
                    } else {
                      const cached = sourceItemsRef.current.get(String(vals[sourceField]))
                      const materialId =
                        cached?.materialId ?? editing?.materialId ?? vals.materialId
                      const unitId = cached?.unitId ?? editing?.unitId ?? vals.unitId
                      if (!materialId || !unitId) {
                        return `请重新选择${spec.sourceItemNoun}以带出物料`
                      }
                    }
                    if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                  }}
                  transformItem={(vals, editing) => {
                    const manual = isManualItem(vals, sourceField)
                    const ditem = manual
                      ? undefined
                      : sourceItemsRef.current.get(String(vals[sourceField]))
                    const material = manual
                      ? (manualMaterialsRef.current.get(String(vals.materialId)) ?? undefined)
                      : undefined
                    const materialId = manual
                      ? (vals.materialId ?? editing?.materialId)
                      : (ditem?.materialId ?? editing?.materialId ?? vals.materialId)
                    const unitId = manual
                      ? (vals.unitId ?? editing?.unitId)
                      : (ditem?.unitId ?? editing?.unitId ?? vals.unitId)
                    return {
                      ...vals,
                      idx: editing
                        ? editing.idx
                        : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                      [sourceField]: manual ? null : vals[sourceField],
                      ...(!editing && !vals.warehouseId && headWarehouse
                        ? { warehouseId: headWarehouse }
                        : {}),
                      materialId,
                      unitId,
                      materialCode:
                        (manual ? material?.code : ditem?.materialCode) ??
                        editing?.materialCode ??
                        vals.materialCode ??
                        null,
                      materialName:
                        (manual ? material?.name : ditem?.materialName) ??
                        editing?.materialName ??
                        vals.materialName ??
                        null,
                      materialSpec:
                        (manual ? material?.spec : ditem?.materialSpec) ??
                        editing?.materialSpec ??
                        vals.materialSpec ??
                        null,
                      customerPartNo:
                        (manual ? material?.customerPartNo : ditem?.customerPartNo) ??
                        editing?.customerPartNo ??
                        vals.customerPartNo ??
                        null,
                      unitName: manual
                        ? (editing?.unitName ?? vals.unitName ?? null)
                        : (ditem?.unitName ?? editing?.unitName ?? vals.unitName ?? null),
                      orderNo: manual
                        ? null
                        : (ditem?.orderNo ?? editing?.orderNo ?? vals.orderNo ?? null),
                    }
                  }}
                />
                {spec.debit && spec.credit ? (
                  <ReturnAccountFooter
                    mode={mode}
                    values={values}
                    patchValues={patchValues}
                    isDisabled={
                      mode === 'view' || (row != null && row.status !== 'DRAFT')
                    }
                    fieldErrors={fieldErrors}
                    debit={spec.debit}
                    credit={spec.credit}
                  />
                ) : null}
              </>
            )
          }}
          onSubmit={async (values, submitMode) => {
            assertAggregateDraftReady(submitMode, drawer.detailLoaded, '退货明细')
            const writerBag = binding.writer as
              | Partial<{ create: unknown; update: unknown }>
              | undefined
            if (writerBag?.create || writerBag?.update) {
              throw new Error(spec.writerGuard)
            }
            const request = spec.buildDraft(
              { ...draftHeadRef.current, ...values },
              items,
            )
            setDraftErrors({})
            setDraftErrorIndex(request.index)
            setSubmitting(true)
            try {
              const saved =
                submitMode === 'create'
                  ? await draftApi.createDraft(request.draft)
                  : await draftApi.replaceDraft(rowId!, request.draft)
              acceptSavedDraft(saved)
              queryClient.setQueryData(
                binding.cache.rowKey(String(saved.id)),
                saved,
              )
              await Promise.all([
                binding.cache.invalidateGrid(queryClient),
                ...spec.invalidateResources.map((resource) =>
                  resourceBindingFor(resource).cache.invalidateGrid(queryClient),
                ),
              ])
              toast.success(`${spec.docLabel}已${submitMode === 'create' ? '创建' : '更新'}`)
              return String(saved.id)
            } catch (error) {
              if (error instanceof APIError && error.fields) {
                setDraftErrors(error.fields)
                setDraftErrorIndex(request.index)
              }
              throw error
            } finally {
              setSubmitting(false)
            }
          }}
        />
      </ReturnDrawerOpenProvider>
    )
  }

  return {
    ReturnDrawerProvider,
    useReturnDrawer,
    returnAuditConfig,
  }
}
