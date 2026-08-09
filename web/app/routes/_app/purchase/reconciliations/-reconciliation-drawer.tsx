import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Input,
  Label,
  NumberField,
  TextField,
  Button,
  toast,
} from '@heroui/react'
import { formatAmount, formatQty } from '~/lib/amount'
import { resourceLabel } from '~/lib/resources/catalog'
import {
  purchaseOutsourcedReceiptItemClient,
  purchaseReceiptItemClient,
} from '~/lib/resources/fulfillment'
import { purchaseReconciliationItemClient } from '~/lib/resources/reconciliations'
import { purchaseReturnItemClient } from '~/lib/resources/returns'
import {
  buildReconciliationDraft,
  type ReconciliationSavedDraft,
} from '~/lib/resources/reconciliation-draft'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { localRowId } from '~/components/synie-editable-table/editable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import type {
  DrawerMode,
  FieldOverride,
} from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { auditMaterialCell, type AuditDocConfig } from '../../scm/-audit-doc'
import { CompanyDefaultSync, defaultCompanyId } from '../../scm/-stock-doc'
import { useAuthorizedCompanies } from '~/lib/form-defaults'
import { fetchCompanyAccountDefaults } from '~/components/company-account-defaults'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { toastError } from '~/lib/toast'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

const purchaseReconciliationDraft = aggregateDraftFor('purReconciliations')

export interface ReconciliationRef {
  id: string
  status?: unknown
}

export type OpenReconciliationDrawer = (
  mode: DrawerMode,
  reconciliation: ReconciliationRef | null,
) => void

const AUDIT_COLUMNS: AuditDocConfig['columns'] = [
  { key: 'receiptNo', label: '入库单号' },
  {
    key: 'materialName',
    label: '物料',
    // 对账行无图纸挂接,不传 drawingOwnerType;行上仅 materialName 平铺快照,富单元格按名降级展示
    render: auditMaterialCell(),
  },
  { key: 'unitName', label: '单位' },
  { key: 'qty', label: '对账数量', align: 'end' },
  { key: 'amount', label: '金额(原币)', align: 'end' },
  { key: 'baseAmount', label: '本币金额', align: 'end' },
  { key: 'remarks', label: '行备注' },
]

// 「供应商确认」(常规单)确认弹窗:列出整单条目核对,与赠送/样品单「结单审核」同一套(见 scm/-audit-doc)
export const reconciliationConfirmConfig = {
  docLabel: '采购对账单',
  resource: 'purReconciliations',
  commandKey: 'confirm',
  itemsResource: 'purReconciliationItems',
  columns: AUDIT_COLUMNS,
  loadItems: (reconciliationId: string) =>
    purchaseReconciliationItemClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: {
          reconciliationId: {
            kind: 'fk',
            op: 'in',
            values: [reconciliationId],
            labels: [],
          },
        },
      })
      .then((result) => result.results),
} satisfies AuditDocConfig

// 「结单审核」(赠送/样品单)确认弹窗
export const reconciliationAuditConfig = {
  docLabel: '采购对账单',
  resource: 'purReconciliations',
  commandKey: 'audit',
  itemsResource: 'purReconciliationItems',
  columns: AUDIT_COLUMNS,
  loadItems: reconciliationConfirmConfig.loadItems,
} satisfies AuditDocConfig

const {
  useOpen: useReconciliationDrawer,
  Provider: ReconciliationDrawerOpenProvider,
} = createDocumentDrawerOpenBridge<OpenReconciliationDrawer>()
export { useReconciliationDrawer }


/** 科目候选使用结构化 REST FilterState。 */
function accountFilter(
  companyId: string | null,
  roleEnum?: string,
): FilterState | undefined {
  if (!companyId) return undefined
  return {
    companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
    isGroup: { kind: 'bool', eq: false },
    active: { kind: 'bool', eq: true },
    ...(roleEnum
      ? { role: { kind: 'enum' as const, values: [roleEnum] } }
      : {}),
  }
}

/**
 * 新建态:公司选定/变更时整组覆盖借贷科目为该公司默认(与后端 FillDefaultAccounts 同口径:
 * 对账单借方 ← 默认入库贷方,对账单贷方 ← 默认入库借方;无默认则清空)。
 * 编辑态公司锁死,不重灌。
 */
function ReconciliationAccountDefaultSync({
  mode,
  companyId,
  patchValues,
}: {
  mode: DrawerMode
  companyId: string | null
  patchValues: (patch: Record<string, unknown>) => void
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
      patchValues({
        debitAccountId: row?.receiptCreditAccountId ?? null,
        creditAccountId: row?.receiptDebitAccountId ?? null,
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, companyId])

  return null
}

function ReconciliationAccountFooter({
  mode,
  values,
  patchValues,
  isDisabled,
}: {
  mode: DrawerMode
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  isDisabled: boolean
}) {
  const companyId = (values.companyId as string | null) ?? null
  const isGift = values.reconciliationType === 'GIFT_SAMPLE'
  const creditLabel = isGift ? '贷方科目(收益类)' : '贷方科目(入库借方口径)'
  const debit =
    values.debitAccountId == null || values.debitAccountId === ''
      ? null
      : String(values.debitAccountId)
  const credit =
    values.creditAccountId == null || values.creditAccountId === ''
      ? null
      : String(values.creditAccountId)

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t border-separator pt-4 lg:grid-cols-2">
      <RemoteSelect
        resource="basAccounts"
        label="借方科目(未开票应付)"
        placeholder={companyId ? '选择未开票应付科目…' : '先选择公司'}
        value={debit}
        onChange={(id) => patchValues({ debitAccountId: id })}
        isDisabled={isDisabled || !companyId || mode === 'view'}
        isRequired={mode !== 'view'}
        filterState={accountFilter(companyId, 'UNBILLED_PAYABLE')}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
      <RemoteSelect
        resource="basAccounts"
        label={creditLabel}
        placeholder={companyId ? `选择${creditLabel}…` : '先选择公司'}
        value={credit}
        onChange={(id) => patchValues({ creditAccountId: id })}
        isDisabled={isDisabled || !companyId || mode === 'view'}
        isRequired={mode !== 'view'}
        filterState={accountFilter(companyId)}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
    </div>
  )
}

/**
 * 可勾入库条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核入库 2. 公司/对手与对账头一致 3. 剩余可对账量 > 0 4. 单内同币种(已有行时)
 * 5. 常规单:禁零金额行(采购订单无样品类型,无"样品来源"禁用——零价赠送行走赠送/样品单;
 *    后端均另有强校验)
 * 使用结构化 REST FilterState。
 */
function receiptItemGridFilter(
  values: Record<string, unknown>,
  items: Row[],
): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  const currency = items.find(
    (r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '',
  )?.orderCurrencyCode
  return {
    receiptStatus: { kind: 'enum', values: ['AUDITED'] },
    companyId: {
      kind: 'fk',
      op: 'in',
      values: [String(companyId)],
      labels: [],
    },
    partyType: { kind: 'enum', values: [String(partyType)] },
    partyId: {
      kind: 'polyFk',
      op: 'in',
      variant: String(partyType),
      values: [String(partyId)],
      labels: [],
    },
    remainingReconcilableQty: { kind: 'number', op: 'gt', value: '0' },
    ...(currency
      ? {
          orderCurrencyCode: {
            kind: 'text' as const,
            op: 'eq' as const,
            value: String(currency),
          },
        }
      : {}),
    ...(values.reconciliationType !== 'GIFT_SAMPLE'
      ? {
          orderPrice: {
            kind: 'number' as const,
            op: 'gt' as const,
            value: '0',
          },
        }
      : {}),
  }
}

function receiptItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining =
    r.remainingReconcilableQty != null
      ? String(r.remainingReconcilableQty)
      : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem =
    remaining != null
      ? `剩余可对账${remaining}${unit ? `(默认单位折算,行单位${unit})` : ''}`
      : ''
  const receiptNo =
    r.receiptNo != null && r.receiptNo !== '' ? String(r.receiptNo) : null
  return [material || '入库条目', rem, receiptNo].filter(Boolean).join(' · ')
}

/**
 * 可勾采购退货条目固定筛选：口径与入库条目一致
 * （已审核未作废/同公司同对手/剩余可对账 > 0/单内同币种/常规单禁零价——
 *  对退货行的含义=禁快照价为零的退货行；委外退货为纯数量单不进池）。
 */
function returnItemGridFilter(
  values: Record<string, unknown>,
  items: Row[],
): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  const currency = items.find(
    (r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '',
  )?.orderCurrencyCode
  return {
    returnStatus: { kind: 'enum', values: ['AUDITED'] },
    companyId: {
      kind: 'fk',
      op: 'in',
      values: [String(companyId)],
      labels: [],
    },
    partyType: { kind: 'enum', values: [String(partyType)] },
    partyId: {
      kind: 'polyFk',
      op: 'in',
      variant: String(partyType),
      values: [String(partyId)],
      labels: [],
    },
    remainingReconcilableQty: { kind: 'number', op: 'gt', value: '0' },
    ...(currency
      ? {
          orderCurrencyCode: {
            kind: 'text' as const,
            op: 'eq' as const,
            value: String(currency),
          },
        }
      : {}),
    ...(values.reconciliationType !== 'GIFT_SAMPLE'
      ? {
          orderPrice: {
            kind: 'number' as const,
            op: 'gt' as const,
            value: '0',
          },
        }
      : {}),
  }
}

function returnItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining =
    r.remainingReconcilableQty != null
      ? String(r.remainingReconcilableQty)
      : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem =
    remaining != null
      ? `剩余可对账${remaining}${unit ? `(默认单位折算,行单位${unit})` : ''}`
      : ''
  const returnNo =
    r.returnNo != null && r.returnNo !== '' ? String(r.returnNo) : null
  return [material || '退货条目', rem, returnNo].filter(Boolean).join(' · ')
}

/** 只读文本字段(物料/单位/币种快照回显) */
function LockedText({ label, value }: { label: string; value: string }) {
  return (
    <TextField isDisabled value={value || '—'}>
      <Label>{label}</Label>
      <Input />
    </TextField>
  )
}

/** 系统计算数值占位(baseQty/amount/baseAmount 由后端算,表单只读) */
function LockedNumber({ label, value }: { label: string; value: unknown }) {
  return (
    <NumberField
      fullWidth
      isDisabled
      value={value == null || value === '' ? NaN : Number(value)}
    >
      <Label>{label}</Label>
      <NumberField.Group className="grid-cols-[1fr]">
        <NumberField.Input placeholder="保存后系统计算" />
      </NumberField.Group>
    </NumberField>
  )
}

/**
 * 头关键字段变更清行(ItemsResetGuard)的指纹字段:公司/对手类型/对手/对账类型任一变则清空条目草稿。
 */
const ITEMS_RESET_FIELDS = ['companyId', 'partyType', 'partyId', 'reconciliationType'] as const

/** 数量(2 位)预览:与后端金额链同形(qty×快照单价),仅草稿展示,落库以后端为准 */
function previewAmount(qty: unknown, price: unknown): number | null {
  const q = Number(qty)
  const p = Number(price)
  if (!Number.isFinite(q) || !Number.isFinite(p)) return null
  return Math.round(q * p * 100) / 100
}

/** 对账整单草稿 + 预热的入库条目缓存(骨架 loadDraft 的返回形) */
type ReconciliationDrawerDraft = ReconciliationSavedDraft & {
  receiptItems: Map<string, Row>
  returnItems: Map<string, Row>
}

/**
 * 采购对账创建/编辑抽屉(头+对账条目)。
 * 对账单/对账条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function ReconciliationDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<ReconciliationDrawerDraft>({
    resource: 'purReconciliations',
    urlSync,
    loadDraft: async (reconciliationId) => {
      // 整单草稿:头+对账条目一次一致读快照;入库条目预热缓存装进 draft 返回
      const draft = await purchaseReconciliationDraft.loadDraft(reconciliationId)
      const rows = draft.items
      // 编辑态预热缓存:按行上入库条目 id 取剩余可对账量/快照价/币种(双来源各自拉取)
      const receiptIds = [
        ...new Set(
          rows
            .map((r) =>
              r.receiptItemId == null ? null : String(r.receiptItemId),
            )
            .filter((v): v is string => v != null),
        ),
      ]
      const outsourcedIds = [
        ...new Set(
          rows
            .map((r) =>
              r.outsourcedReceiptItemId == null
                ? null
                : String(r.outsourcedReceiptItemId),
            )
            .filter((v): v is string => v != null),
        ),
      ]
      const returnIds = [
        ...new Set(
          rows
            .map((r) =>
              r.returnItemId == null ? null : String(r.returnItemId),
            )
            .filter((v): v is string => v != null),
        ),
      ]
      const receiptItems = new Map<string, Row>()
      const returnItems = new Map<string, Row>()
      try {
        const [normal, outsourced, returns] = await Promise.all([
          receiptIds.length > 0
            ? Promise.all(
                receiptIds.map((id) => purchaseReceiptItemClient.get(id)),
              )
            : Promise.resolve([] as Row[]),
          outsourcedIds.length > 0
            ? Promise.all(
                outsourcedIds.map((id) =>
                  purchaseOutsourcedReceiptItemClient.get(id),
                ),
              )
            : Promise.resolve([] as Row[]),
          returnIds.length > 0
            ? Promise.all(returnIds.map((id) => purchaseReturnItemClient.get(id)))
            : Promise.resolve([] as Row[]),
        ])
        for (const ri of [...normal, ...outsourced].filter(
          (row): row is Row => row != null,
        )) {
          receiptItems.set(String(ri.id), ri)
        }
        for (const ri of returns.filter((row): row is Row => row != null)) {
          returnItems.set(String(ri.id), ri)
        }
      } catch {
        /* 预热失败不挡开单:行仍可看,剩余量校验由后端兜底 */
      }
      // 行上缺的物料编号/规格/客户料号从预热缓存补齐(表格多行展示用)
      const enriched = rows.map((r) => {
        const refId = r.receiptItemId ?? r.outsourcedReceiptItemId ?? r.returnItemId
        const ri =
          refId != null
            ? (receiptItems.get(String(refId)) ?? returnItems.get(String(refId)))
            : undefined
        if (!ri) return r
        return {
          ...r,
          materialCode: r.materialCode ?? ri.materialCode ?? null,
          materialSpec: r.materialSpec ?? ri.materialSpec ?? null,
          customerPartNo: r.customerPartNo ?? ri.customerPartNo ?? null,
        }
      })
      return { ...draft, items: enriched, receiptItems, returnItems }
    },
  })
  const { isOpen, mode, rowId } = drawer
  const reconciliationStatus = drawer.row?.status
  const [items, setItems] = useState<Row[]>([])
  const [importing, setImporting] = useState(false)
  const [filters] = useState<FilterState>({})
  // 入库/退货条目缓存:选择时写入完整行,validateItem/transformItem 带剩余量与快照价
  const receiptItemsRef = useRef(new Map<string, Row>())
  const returnItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const draftHeadRef = useRef<Row | null>(null)

  const companies = useAuthorizedCompanies()

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const resetItems = useCallback(
    () => setItems((cur) => (cur.length === 0 ? cur : [])),
    [],
  )

  // 草稿 → 条目状态派生:draft 变化(含关闭/新建清空为 null)时初始化条目、写 draftHeadRef 并重建入库条目缓存
  useEffect(() => {
    draftHeadRef.current = drawer.draft
    receiptItemsRef.current = drawer.draft?.receiptItems ?? new Map()
    returnItemsRef.current = drawer.draft?.returnItems ?? new Map()
    setItems(drawer.draft?.items ?? [])
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenReconciliationDrawer = (nextMode, reconciliation) => {
    drawer.open(nextMode, reconciliation)
  }

  const baseCfg = drawerConfig('purReconciliations')
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      companyId: {
        ...baseCfg.fields?.companyId,
        defaultValue: createDefaultCompany,
        effects: () => ({ debitAccountId: null, creditAccountId: null }),
      },
    },
  }

  return (
    <ReconciliationDrawerOpenProvider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="purReconciliations"
        {...drawerCfg}
        mode={mode}
        isOpen={isOpen}
        isSubmitDisabled={mode === 'edit' && !drawer.detailLoaded}
        onOpenChange={(open) => {
          if (!open) drawer.close()
        }}
        rowId={rowId}
        onEdit={
          reconciliationStatus === 'DRAFT'
            ? () => drawer.setMode('edit')
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          const isGift = values.reconciliationType === 'GIFT_SAMPLE'
          const headerReady = Boolean(
            values.companyId && values.partyType && values.partyId,
          )
          const riGridFilter = receiptItemGridFilter(values, items)
          const tiGridFilter = returnItemGridFilter(values, items)
          const docCurrency =
            items.find(
              (r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '',
            )?.orderCurrencyCode ?? null

          // 「导入所有未对账」:按选择弹窗同口径拉全部候选(采购入库+委外入库+
          // 采购退货三池,字段口径一致),跳过已在清单的条目,数量默认=剩余可对账量(折行单位);
          // 退货行金额预览取负
          const importAllUnreconciled = async () => {
            if (!riGridFilter || !tiGridFilter) return
            setImporting(true)
            try {
              const fetchPool = async (
                client:
                  | typeof purchaseReceiptItemClient
                  | typeof purchaseOutsourcedReceiptItemClient
                  | typeof purchaseReturnItemClient,
                sortColumn: 'receiptDate' | 'returnDate',
                filter: FilterState,
              ): Promise<Row[]> => {
                const candidates: Row[] = []
                let offset = 0
                for (;;) {
                  const page = await client.query({
                    limit: 200,
                    offset,
                    sort: { column: sortColumn, direction: 'ascending' },
                    filter,
                  })
                  candidates.push(...page.results)
                  // 按实际返回行数推进:limit 可能被 max_page_size 钳制(同 fetchAllRows 纪律)
                  offset += page.results.length
                  if (
                    candidates.length >= page.count ||
                    page.results.length === 0
                  )
                    break
                }
                return candidates
              }
              const [normal, outsourced, returns] = await Promise.all([
                fetchPool(purchaseReceiptItemClient, 'receiptDate', riGridFilter),
                fetchPool(purchaseOutsourcedReceiptItemClient, 'receiptDate', riGridFilter),
                fetchPool(purchaseReturnItemClient, 'returnDate', tiGridFilter),
              ])
              const listed = new Set(
                items.flatMap((r) =>
                  [r.receiptItemId, r.outsourcedReceiptItemId, r.returnItemId]
                    .filter((v) => v != null)
                    .map((v) => String(v)),
                ),
              )
              const fresh: { ri: Row; source: 'receipt' | 'outsourced' | 'return' }[] = [
                ...normal.map((ri) => ({ ri, source: 'receipt' as const })),
                ...outsourced.map((ri) => ({
                  ri,
                  source: 'outsourced' as const,
                })),
                ...returns.map((ri) => ({ ri, source: 'return' as const })),
              ].filter(({ ri }) => !listed.has(String(ri.id)))
              if (fresh.length === 0) {
                toast.warning('没有可导入的未对账入库/退货条目')
                return
              }
              // 清单为空时 filter 未钉币种:候选跨币种则无法保证单内同币种,先手工选一行钉住
              if (
                items.length === 0 &&
                new Set(
                  fresh.map(({ ri }) => String(ri.orderCurrencyCode ?? '')),
                ).size > 1
              ) {
                toast.warning(
                  '未对账条目存在多个币种,请先手工新增一行钉住币种后再导入',
                )
                return
              }
              let maxIdx = items.reduce(
                (m, r) => Math.max(m, Number(r.idx) || 0),
                0,
              )
              const imported = fresh.map(({ ri, source }) => {
                const isReturn = source === 'return'
                if (isReturn) returnItemsRef.current.set(String(ri.id), ri)
                else receiptItemsRef.current.set(String(ri.id), ri)
                const remaining = Number(ri.remainingReconcilableQty)
                const ratio =
                  Number(ri.baseQty) > 0
                    ? Number(ri.qty) / Number(ri.baseQty)
                    : 1
                // 数量默认=剩余可对账量(折行单位,6 位去尾差);金额按金额链 2 位预览,落库以后端为准
                const qty = Math.round(remaining * ratio * 1e6) / 1e6
                const amount = previewAmount(qty, ri.orderPrice)
                const baseAmount = previewAmount(qty, ri.orderBasePrice)
                return {
                  id: localRowId(),
                  idx: ++maxIdx,
                  receiptItemId: source === 'receipt' ? ri.id : null,
                  outsourcedReceiptItemId:
                    source === 'outsourced' ? ri.id : null,
                  returnItemId: isReturn ? ri.id : null,
                  qty,
                  remarks: null,
                  materialCode: ri.materialCode ?? null,
                  materialName: ri.materialName ?? null,
                  materialSpec: ri.materialSpec ?? null,
                  customerPartNo: ri.customerPartNo ?? null,
                  unitName: ri.unitName ?? null,
                  receiptNo: isReturn ? (ri.returnNo ?? null) : (ri.receiptNo ?? null),
                  orderCurrencyCode: ri.orderCurrencyCode ?? null,
                  amount: isReturn && amount != null ? -amount : amount,
                  baseAmount: isReturn && baseAmount != null ? -baseAmount : baseAmount,
                }
              })
              setItems((cur) => [...cur, ...imported])
              toast.success(`已导入 ${imported.length} 条未对账入库/退货条目`)
            } catch (e) {
              toastError('导入未对账条目失败')(e)
            } finally {
              setImporting(false)
            }
          }

          // 条目录入:弹窗选来源条目后锁定回填物料/单位/币种快照;用户只填数量/行备注。
          // 来源三来源恰一(采购入库/委外入库/采购退货):picker 互斥,选一个清空另外两个
          const makeItemPicker = (
            field: 'receiptItemId' | 'outsourcedReceiptItemId' | 'returnItemId',
            resource: 'purReceiptItems' | 'purOutsourcedReceiptItems' | 'purReturnItems',
            label: string,
          ) =>
            function ItemPickerInput({
              value,
              onChange,
              isDisabled,
              patchValues: patchItem,
            }: {
              value: unknown
              onChange: (v: unknown) => void
              isDisabled: boolean
              patchValues: (patch: Record<string, unknown>) => void
            }) {
              const isReturn = field === 'returnItemId'
              const gridFilter = isReturn ? tiGridFilter : riGridFilter
              return (
                <RemoteDialogSelect
                  resource={resource}
                  label={label}
                  dialogTitle={`选择可对账${label}`}
                  placeholder={
                    gridFilter ? `点击选择${label}…` : '先选齐公司与对手'
                  }
                  labelField="materialName"
                  fields={[
                    'materialCode',
                    'materialName',
                    'materialSpec',
                    'customerPartNo',
                    'unitName',
                    'qty',
                    'baseQty',
                    'reconciledQty',
                    'remainingReconcilableQty',
                    'orderNo',
                    'orderPrice',
                    'orderBasePrice',
                    'orderCurrencyCode',
                    field === 'returnItemId' ? 'returnNo' : 'receiptNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, ritem) => {
                    if (id && ritem) {
                      ;(isReturn ? returnItemsRef : receiptItemsRef).current.set(
                        String(id),
                        ritem,
                      )
                    }
                    onChange(id)
                    // 物料/单位/币种随来源条目锁定带出;collectValues 会丢 hidden 字段,
                    // 真正落行靠 transformItem 读缓存。三来源互斥:选一个清空另外两个
                    patchItem({
                      receiptItemId: null,
                      outsourcedReceiptItemId: null,
                      returnItemId: null,
                      [field]: id,
                      materialCode: ritem?.materialCode ?? null,
                      materialName: ritem?.materialName ?? null,
                      materialSpec: ritem?.materialSpec ?? null,
                      customerPartNo: ritem?.customerPartNo ?? null,
                      unitName: ritem?.unitName ?? null,
                      orderCurrencyCode: ritem?.orderCurrencyCode ?? null,
                      receiptNo: isReturn
                        ? (ritem?.returnNo ?? null)
                        : (ritem?.receiptNo ?? null),
                    })
                  }}
                  isDisabled={isDisabled || gridFilter == null}
                  gridFilter={gridFilter ?? undefined}
                  gridColumns={[
                    isReturn ? 'returnDate' : 'receiptDate',
                    isReturn ? 'returnNo' : 'receiptNo',
                    'orderNo',
                    'materialCode',
                    'materialName',
                    'customerPartNo',
                    'unitName',
                    'qty',
                    'reconciledQty',
                    'remainingReconcilableQty',
                    'orderPrice',
                    'orderCurrencyCode',
                  ]}
                  gridOverrides={{
                    receiptDate: { label: '入库日期' },
                    receiptNo: { label: '入库单号' },
                    returnDate: { label: '退货日期' },
                    returnNo: { label: '退货单号' },
                    orderNo: { label: '订单号' },
                    materialCode: { label: '物料编号' },
                    materialName: { label: '物料名称' },
                    customerPartNo: { label: '客户料号' },
                    unitName: { label: '单位' },
                    qty: {
                      label: isReturn ? '退货数量' : '入库数量',
                      render: (v: unknown) => formatQty(v) || undefined,
                    },
                    reconciledQty: {
                      label: '已对账数量',
                      render: (v: unknown) => formatQty(v) || undefined,
                    },
                    remainingReconcilableQty: {
                      label: '剩余可对账',
                      render: (v: unknown) => formatQty(v) || undefined,
                    },
                    orderPrice: { label: '含税单价' },
                    orderCurrencyCode: { label: '币种' },
                  }}
                  gridDefaultSort={{
                    column: isReturn ? 'returnDate' : 'receiptDate',
                    direction: 'descending',
                  }}
                  gridExtraFields={[
                    'baseQty',
                    'orderBasePrice',
                    'materialSpec',
                    'reconciledQty',
                    'remainingReconcilableQty',
                  ]}
                  dialogClassName="max-w-6xl"
                  renderValue={(r) =>
                    isReturn ? returnItemDisplay(r) : receiptItemDisplay(r)
                  }
                />
              )
            }

          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            receiptItemId: {
              order: 0,
              cols: 4,
              label: '入库条目(采购)',
              input: makeItemPicker('receiptItemId', 'purReceiptItems', '入库条目(采购)'),
            },
            outsourcedReceiptItemId: {
              order: 0,
              cols: 4,
              label: '入库条目(委外)',
              input: makeItemPicker(
                'outsourcedReceiptItemId',
                'purOutsourcedReceiptItems',
                '入库条目(委外)',
              ),
            },
            returnItemId: {
              order: 0,
              cols: 4,
              label: '采购退货条目(金额取负)',
              input: makeItemPicker(
                'returnItemId',
                'purReturnItems',
                '采购退货条目',
              ),
            },
            // 物料/单位/币种只读回显(值由入库条目 patch 写入)
            materialName: {
              order: 1,
              label: '物料',
              input: ({ values: iv }) => {
                const code =
                  iv.materialCode != null ? String(iv.materialCode) : ''
                const name =
                  iv.materialName != null ? String(iv.materialName) : ''
                const text =
                  [code, name].filter(Boolean).join(' ') ||
                  '选入库条目后自动带出'
                return <LockedText label="物料" value={text} />
              },
            },
            unitName: {
              order: 2,
              cols: 6,
              label: '单位',
              input: ({ values: iv }) => (
                <LockedText
                  label="单位"
                  value={
                    iv.unitName != null
                      ? String(iv.unitName)
                      : '选入库条目后自动带出'
                  }
                />
              ),
            },
            orderCurrencyCode: {
              order: 3,
              cols: 6,
              label: '币种',
              input: ({ values: iv }) => (
                <LockedText
                  label="币种(订单原币,单内须一致)"
                  value={
                    iv.orderCurrencyCode != null
                      ? String(iv.orderCurrencyCode)
                      : '—'
                  }
                />
              ),
            },
            qty: { order: 4, cols: 6, required: true, label: '对账数量' },
            baseQty: {
              order: 5,
              cols: 6,
              label: '折算数量',
              input: ({ value }) => (
                <LockedNumber label="折算数量(默认单位)" value={value} />
              ),
            },
            amount: {
              order: 6,
              cols: 6,
              label: '金额(原币含税)',
              input: ({ value, values: iv }) => {
                const isReturn = iv.returnItemId != null && iv.returnItemId !== ''
                const refId =
                  iv.receiptItemId ?? iv.outsourcedReceiptItemId ?? iv.returnItemId
                const ritem =
                  refId != null
                    ? (receiptItemsRef.current.get(String(refId)) ??
                      returnItemsRef.current.get(String(refId)))
                    : undefined
                const raw =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ritem?.orderPrice)
                const preview =
                  isReturn && raw != null && raw !== '' ? -Number(raw) : raw
                return (
                  <LockedNumber
                    label={
                      isReturn
                        ? '金额(原币含税,退货取负)'
                        : '金额(原币含税,数量×快照单价)'
                    }
                    value={preview}
                  />
                )
              },
            },
            baseAmount: {
              order: 7,
              cols: 6,
              label: '本币金额',
              input: ({ value, values: iv }) => {
                const isReturn = iv.returnItemId != null && iv.returnItemId !== ''
                const refId =
                  iv.receiptItemId ?? iv.outsourcedReceiptItemId ?? iv.returnItemId
                const ritem =
                  refId != null
                    ? (receiptItemsRef.current.get(String(refId)) ??
                      returnItemsRef.current.get(String(refId)))
                    : undefined
                const raw =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ritem?.orderBasePrice)
                const preview =
                  isReturn && raw != null && raw !== '' ? -Number(raw) : raw
                return (
                  <LockedNumber
                    label={isReturn ? '本币金额(含税,退货取负)' : '本币金额(含税)'}
                    value={preview}
                  />
                )
              },
            },
            remarks: { order: 8, label: '行备注' },
            // 手改快照入口彻底隐藏(值仍随入库条目写入草稿行)
            materialCode: { visible: () => false },
            materialSpec: { visible: () => false },
            customerPartNo: { visible: () => false },
            receiptNo: { visible: () => false },
          }

          const totalAmount = items.reduce(
            (acc, r) => acc + (Number(r.amount) || 0),
            0,
          )
          const totalBaseAmount = items.reduce(
            (acc, r) => acc + (Number(r.baseAmount) || 0),
            0,
          )
          const itemsReadOnly =
            mode === 'view' ||
            (row != null && row.status !== 'DRAFT') ||
            (mode !== 'create' && !drawer.detailLoaded)

          return (
            <>
              <CompanyDefaultSync
                mode={mode}
                values={values}
                patchValues={patchValues}
                defaultId={createDefaultCompany}
              />
              <ReconciliationAccountDefaultSync
                key={`acct-${rowId ?? 'create'}-${drawer.generation}`}
                mode={mode}
                companyId={(values.companyId as string | null) ?? null}
                patchValues={patchValues}
              />
              {/* key 随开抽屉世代变,保证每次打开重新布防基线 */}
              <ItemsResetGuard
                key={`${rowId ?? 'create'}-${drawer.generation}`}
                mode={mode}
                row={row}
                values={values}
                fields={ITEMS_RESET_FIELDS}
                onReset={resetItems}
              />
              <SynieEditableTable
                resource="purReconciliationItems"
                label="对账条目"
                items={items}
                onChange={setItems}
                readOnly={itemsReadOnly}
                canCreate={headerReady}
                toolbar={
                  itemsReadOnly ? undefined : (
                    <div className="flex items-center gap-2">
                      {!headerReady && (
                        <span className="text-xs text-muted">
                          先选齐公司、对手类型与对手
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={!headerReady || importing}
                        onPress={() => void importAllUnreconciled()}
                      >
                        {importing ? '导入中…' : '导入所有未对账'}
                      </Button>
                    </div>
                  )
                }
                drawerClassName="w-full lg:w-[560px]"
                exclude={[
                  'reconciliationId',
                  'companyId',
                  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
                  'reconciliationNo',
                  'reconciliationStatus',
                  'receiptDate',
                  // receiptNo/materialCode/materialSpec/customerPartNo 仍在 fields 里
                  // visible:false 以保留提交值
                ]}
                columns={[
                  'idx',
                  'receiptNo',
                  'materialName',
                  'unitName',
                  'qty',
                  'baseQty',
                  'amount',
                  'baseAmount',
                  'remarks',
                ]}
                overrides={{
                  receiptNo: { label: '来源单号(入库/退货)' },
                  // 物料列:全站统一富单元格。materialCode 不是对账条目 meta 字段,列载体仍用
                  // materialName;编号/规格/客户料号由入库条目缓存补齐(见 loadDraft 的 enriched)
                  materialName: {
                    label: '物料',
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: materialCellRender(),
                  },
                  unitName: { label: '单位' },
                  qty: { render: (v) => formatQty(v) || undefined },
                  baseQty: {
                    label: '折算数量',
                    render: (v) => formatQty(v) || undefined,
                  },
                  amount: {
                    label: '金额(原币)',
                    render: (v) => formatAmount(v) || undefined,
                  },
                  baseAmount: {
                    label: '本币金额',
                    render: (v) => formatAmount(v) || undefined,
                  },
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, curItems, editing) => {
                  const refId =
                    vals.receiptItemId ??
                    vals.outsourcedReceiptItemId ??
                    vals.returnItemId
                  if (!refId)
                    return '请选择来源条目(采购入库/委外入库/采购退货,恰选一)'
                  const pickedCount = [
                    vals.receiptItemId,
                    vals.outsourcedReceiptItemId,
                    vals.returnItemId,
                  ].filter((v) => v != null && v !== '').length
                  if (pickedCount > 1) return '来源条目只能恰选一个'
                  if (
                    curItems.some(
                      (r) =>
                        r.id !== editing?.id &&
                        [r.receiptItemId, r.outsourcedReceiptItemId, r.returnItemId]
                          .filter((v) => v != null)
                          .map(String)
                          .includes(String(refId)),
                    )
                  )
                    return '该来源条目已在清单中'
                  if (!(Number(vals.qty) > 0)) return '对账数量必须大于零'
                  // 单内同币种:以首个他行币种为基准(弹窗已过滤,这里双保险)
                  const ritem =
                    receiptItemsRef.current.get(String(refId)) ??
                    returnItemsRef.current.get(String(refId))
                  const rowCurrency =
                    ritem?.orderCurrencyCode ??
                    vals.orderCurrencyCode ??
                    editing?.orderCurrencyCode
                  const other = curItems.find(
                    (r) =>
                      r.id !== editing?.id &&
                      r.orderCurrencyCode != null &&
                      r.orderCurrencyCode !== '',
                  )
                  if (
                    other &&
                    rowCurrency != null &&
                    String(other.orderCurrencyCode) !== String(rowCurrency)
                  )
                    return `同一对账单内订单原币必须一致(已选 ${String(other.orderCurrencyCode)})`
                  // 常规单禁零金额行(弹窗已滤,金额这里双保险;后端强校验)
                  if (!isGift && ritem && !(Number(ritem.orderPrice) > 0))
                    return '常规对账单不可勾选零金额条目'
                  // 对账数量 ≤ 剩余可对账量(剩余是默认单位口径,按行单位比例折算比较;后端权威校验)
                  if (ritem?.remainingReconcilableQty != null) {
                    const remaining = Number(ritem.remainingReconcilableQty)
                    const ratio =
                      Number(ritem.baseQty) > 0
                        ? Number(ritem.qty) / Number(ritem.baseQty)
                        : 1
                    const remainingRow = remaining * ratio
                    if (Number(vals.qty) > remainingRow + 1e-9)
                      return `超出剩余可对账量(按行单位约 ${remainingRow.toFixed(4)} ${String(ritem.unitName ?? '')})`
                  }
                }}
                transformItem={(vals, editing) => {
                  const isReturn =
                    vals.returnItemId != null && vals.returnItemId !== ''
                  const refId =
                    vals.receiptItemId ??
                    vals.outsourcedReceiptItemId ??
                    vals.returnItemId
                  const ritem =
                    refId != null
                      ? (receiptItemsRef.current.get(String(refId)) ??
                        returnItemsRef.current.get(String(refId)))
                      : undefined
                  const pick = (key: string) =>
                    ritem?.[key] ?? editing?.[key] ?? vals[key] ?? null
                  const qty = vals.qty
                  const sameRef =
                    editing != null &&
                    String(editing.receiptItemId ?? '') ===
                      String(vals.receiptItemId ?? '') &&
                    String(editing.outsourcedReceiptItemId ?? '') ===
                      String(vals.outsourcedReceiptItemId ?? '') &&
                    String(editing.returnItemId ?? '') ===
                      String(vals.returnItemId ?? '')
                  const amountPreview = previewAmount(qty, ritem?.orderPrice)
                  const basePreview = previewAmount(qty, ritem?.orderBasePrice)
                  // hidden 字段不会进 collectValues:快照以缓存或编辑行补全;
                  // 金额按金额链预算 2 位预览(保存时后端重算为准);退货来源取负
                  return {
                    ...vals,
                    receiptItemId: vals.receiptItemId ?? null,
                    outsourcedReceiptItemId:
                      vals.outsourcedReceiptItemId ?? null,
                    returnItemId: vals.returnItemId ?? null,
                    idx: editing
                      ? editing.idx
                      : items.reduce(
                          (max, r) => Math.max(max, Number(r.idx) || 0),
                          0,
                        ) + 1,
                    materialCode: pick('materialCode'),
                    materialName: pick('materialName'),
                    materialSpec: pick('materialSpec'),
                    customerPartNo: pick('customerPartNo'),
                    unitName: pick('unitName'),
                    receiptNo: isReturn
                      ? (ritem?.returnNo ?? editing?.receiptNo ?? null)
                      : pick('receiptNo'),
                    orderCurrencyCode: pick('orderCurrencyCode'),
                    amount:
                      (isReturn && amountPreview != null
                        ? -amountPreview
                        : amountPreview) ??
                      (sameRef ? (editing?.amount ?? null) : null),
                    baseAmount:
                      (isReturn && basePreview != null ? -basePreview : basePreview) ??
                      (sameRef ? (editing?.baseAmount ?? null) : null),
                  }
                }}
              />
              {items.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                  <span className="text-muted">
                    合计(原币{docCurrency ? ` ${String(docCurrency)}` : ''}):
                    <span className="ml-1 font-medium text-ink-900">
                      {formatAmount(totalAmount)}
                    </span>
                  </span>
                  <span className="text-muted">
                    本币合计:
                    <span className="ml-1 font-medium text-ink-900">
                      {formatAmount(totalBaseAmount)}
                    </span>
                  </span>
                </div>
              )}
              <ReconciliationAccountFooter
                mode={mode}
                values={values}
                patchValues={patchValues}
                isDisabled={
                  mode === 'view' || (row != null && row.status !== 'DRAFT')
                }
              />
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          assertAggregateDraftReady(mode, drawer.detailLoaded, '采购对账明细')
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          const draft = buildReconciliationDraft(
            'purchase',
            { ...draftHeadRef.current, ...values },
            items,
          )
          let saved: Row
          if (mode === 'create') {
            saved = await purchaseReconciliationDraft.createDraft(draft)
            toast.success(`${resourceLabel('purReconciliations')}已创建`)
          } else {
            saved = await purchaseReconciliationDraft.replaceDraft(rowId!, draft)
            toast.success(`${resourceLabel('purReconciliations')}已更新`)
          }
          await Promise.all([
            resourceBindingFor('purReconciliations').cache.invalidateAll(
              queryClient,
            ),
            resourceBindingFor(
              'purReconciliationItems',
            ).cache.invalidateGrid(queryClient),
            resourceBindingFor('purReturnItems').cache.invalidateGrid(queryClient),
            resourceBindingFor('purReceiptItems').cache.invalidateGrid(queryClient),
          ])
          return String(saved.id)
        }}
      />
    </ReconciliationDrawerOpenProvider>
  )
}
