import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Input, Label, NumberField, TextField, Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount, formatQty } from '~/lib/amount'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow, localRowId } from '~/components/synie-editable-table/editable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { gqlEnum, toGqlLiteral } from '~/components/synie-data-grid/query'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { auditMaterialCell, type AuditDocConfig } from '../-audit-doc'
import { CompanyDefaultSync, defaultCompanyId } from '../-stock-doc'
import { fetchCompanyAccountDefaults } from '../settings/-company-account-defaults'

export interface ReconciliationRef {
  id: string
  status?: unknown
}

export type OpenReconciliationDrawer = (
  mode: DrawerMode,
  reconciliation: ReconciliationRef | null,
) => void

const AUDIT_ITEM_FIELDS =
  'id idx receiptNo materialName unitName qty baseQty amount baseAmount remarks'

const AUDIT_COLUMNS: AuditDocConfig['columns'] = [
  { key: 'receiptNo', label: '入库单号' },
  {
    key: 'materialName',
    label: '物料',
    render: auditMaterialCell({ key: 'customerPartNo', label: '客户料号' }),
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
  mutation: 'confirmPurReconciliation',
  itemsResource: 'purReconciliationItems',
  docIdField: 'reconciliationId',
  itemFields: AUDIT_ITEM_FIELDS,
  columns: AUDIT_COLUMNS,
} satisfies AuditDocConfig

// 「结单审核」(赠送/样品单)确认弹窗
export const reconciliationAuditConfig = {
  docLabel: '采购对账单',
  mutation: 'auditPurReconciliation',
  itemsResource: 'purReconciliationItems',
  docIdField: 'reconciliationId',
  itemFields: AUDIT_ITEM_FIELDS,
  columns: AUDIT_COLUMNS,
} satisfies AuditDocConfig

const ReconciliationDrawerContext = createContext<OpenReconciliationDrawer>(() => {})

export function useReconciliationDrawer(): OpenReconciliationDrawer {
  return useContext(ReconciliationDrawerContext)
}

const CREATE_RECONCILIATION = `
  mutation ($input: CreatePurReconciliationInput!) {
    createPurReconciliation(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_RECONCILIATION = `
  mutation ($id: ID!, $input: UpdatePurReconciliationInput!) {
    updatePurReconciliation(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 只取快照/calculation 与 id 字段,不 join material/receipt——
// 嵌套加载会走对方资源权限,无 read 时 GraphQL 非空关系变 null 整查询失败(同发货抽屉先例)。
// 物料编号/规格/客户料号不在行 calculation 上,由入库条目预热缓存按 receiptItemId 补(见 openDrawer)。
const FETCH_ITEMS = `
  query ($reconciliationId: ID!) {
    purReconciliationItems(
      filter: {reconciliationId: {eq: $reconciliationId}}
      sort: [{field: IDX, order: ASC}]
      limit: 200
      offset: 0
    ) {
      results {
        id idx receiptItemId qty baseQty amount baseAmount remarks
        materialName unitName receiptNo orderCurrencyCode
      }
    }
  }
`
// 编辑态预热入库条目缓存:剩余可对账量/快照单价/币种等,存量行不点选入库条目也能过校验/回填
const FETCH_RECEIPT_ITEMS = `
  query ($ids: [ID!]!) {
    purReceiptItems(filter: {id: {in: $ids}}, limit: 200, offset: 0) {
      results {
        id qty baseQty reconciledQty remainingReconcilableQty
        orderNo orderPrice orderBasePrice orderCurrencyCode
        materialCode materialName materialSpec customerPartNo unitName receiptNo
      }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreatePurReconciliationItemInput!) {
    createPurReconciliationItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdatePurReconciliationItemInput!) {
    updatePurReconciliationItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyPurReconciliationItem(id: $id) { errors { message } }
  }
`

/** 提交 mutation:金额/baseQty 由后端按金额链与折算比例算(不可手改) */
function itemInput(row: Row) {
  return {
    idx: row.idx,
    receiptItemId: row.receiptItemId,
    qty: row.qty,
    remarks: row.remarks ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['idx', 'receiptItemId', 'qty', 'remarks'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

interface MutationResult {
  result?: { id: string } | null
  errors: { message: string }[] | null
}

async function persistItems(
  reconciliationId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  const errors: string[] = []
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyPurReconciliationItem: MutationResult }>(DESTROY_ITEM, {
      id: old.id,
    })
    collect(old.idx, data.destroyPurReconciliationItem?.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createPurReconciliationItem: MutationResult }>(CREATE_ITEM, {
        input: { reconciliationId, ...itemInput(row) },
      })
      collect(row.idx, data.createPurReconciliationItem?.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updatePurReconciliationItem: MutationResult }>(UPDATE_ITEM, {
        id: row.id,
        input: itemInput(row),
      })
      collect(row.idx, data.updatePurReconciliationItem?.errors)
    }
  }
  return errors
}

/**
 * 科目候选 filter。枚举值必须是 GraphQL enum 裸 token(不可 JSON 字符串)。
 * 借方强制未开票应付(同后端校验);贷方角色不限(常规=入库借方口径,赠送/样品=收益类)。
 */
function accountFilter(companyId: string | null, roleEnum?: string): string | undefined {
  if (!companyId) return undefined
  const base = `companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}`
  if (roleEnum) return `{${base}, role: {eq: ${roleEnum}}}`
  return `{${base}}`
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
  const debit = values.debitAccountId == null || values.debitAccountId === '' ? null : String(values.debitAccountId)
  const credit =
    values.creditAccountId == null || values.creditAccountId === '' ? null : String(values.creditAccountId)

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
        filter={accountFilter(companyId, 'UNBILLED_PAYABLE')}
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
        filter={accountFilter(companyId)}
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
 * 枚举值用 gqlEnum 包装(不可 JSON 字符串)。
 */
function receiptItemGridFilter(
  values: Record<string, unknown>,
  items: Row[],
): Record<string, unknown> | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  const currency = items.find((r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '')
    ?.orderCurrencyCode
  const isRegular = values.reconciliationType !== 'GIFT_SAMPLE'
  return {
    and: [
      { receiptStatus: { eq: gqlEnum('AUDITED') } },
      { companyId: { eq: String(companyId) } },
      { partyType: { eq: gqlEnum(String(partyType)) } },
      { partyId: { eq: String(partyId) } },
      { remainingReconcilableQty: { greaterThan: '0' } },
      ...(currency ? [{ orderCurrencyCode: { eq: String(currency) } }] : []),
      ...(isRegular ? [{ orderPrice: { greaterThan: '0' } }] : []),
    ],
  }
}

function receiptItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining = r.remainingReconcilableQty != null ? String(r.remainingReconcilableQty) : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem = remaining != null ? `剩余可对账${remaining}${unit ? `(默认单位折算,行单位${unit})` : ''}` : ''
  const receiptNo = r.receiptNo != null && r.receiptNo !== '' ? String(r.receiptNo) : null
  return [material || '入库条目', rem, receiptNo].filter(Boolean).join(' · ')
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
 * 头关键字段变更清行:公司/对手类型/对手/对账类型任一变则清空条目草稿
 * (与发货抽屉 ItemsResetGuard 同构;edit 等行主数据回填后再布防)。
 */
function ItemsResetGuard({
  mode,
  row,
  values,
  onReset,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  onReset: () => void
}) {
  const armedRef = useRef(false)
  const baselineRef = useRef('')
  const fpOf = (v: Record<string, unknown>) =>
    [v.companyId, v.partyType, v.partyId, v.reconciliationType]
      .map((x) => String(x ?? ''))
      .join('|')
  const fp = fpOf(values)
  const rowFp = row != null ? fpOf(row) : null

  useEffect(() => {
    if (mode === 'view') return
    if (!armedRef.current) {
      if (mode === 'create' || (rowFp != null && fp === rowFp)) {
        baselineRef.current = fp
        armedRef.current = true
      }
      return
    }
    if (fp !== baselineRef.current) {
      baselineRef.current = fp
      onReset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, rowFp, mode, onReset])

  return null
}

/** 数量(2 位)预览:与后端金额链同形(qty×快照单价),仅草稿展示,落库以后端为准 */
function previewAmount(qty: unknown, price: unknown): number | null {
  const q = Number(qty)
  const p = Number(price)
  if (!Number.isFinite(q) || !Number.isFinite(p)) return null
  return Math.round(q * p * 100) / 100
}

export function ReconciliationDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: ReconciliationRef | null } | null>(
    null,
  )
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [importing, setImporting] = useState(false)
  const [filters] = useState<FilterState>({})
  // 入库条目缓存:选择时写入完整行,validateItem/transformItem 带剩余量与快照价
  const receiptItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const companies = useQuery({
    queryKey: ['purReconciliations', 'companies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { results { id name } } }`,
      ).then((d) => d.basCompanies.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const resetItems = useCallback(() => setItems((cur) => (cur.length === 0 ? cur : [])), [])

  const openDrawer = useCallback<OpenReconciliationDrawer>((mode, reconciliation) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row: reconciliation })
    receiptItemsRef.current = new Map()
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    const reconciliationId = reconciliation?.id
    // 防前端把 String(undefined) 当成 uuid 过滤(Invalid filter value "undefined")
    if (reconciliationId == null || reconciliationId === '' || reconciliationId === 'undefined') {
      toast.danger('无法打开采购对账单', { description: '缺少对账单 id' })
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{ purReconciliationItems: { results: Row[] } }>(FETCH_ITEMS, {
      reconciliationId,
    })
      .then(async (d) => {
        if (my !== reqIdRef.current) return
        const rows = d.purReconciliationItems.results
        // 编辑态预热缓存:按行上入库条目 id 取剩余可对账量/快照价/币种
        const ids = [
          ...new Set(
            rows
              .map((r) => (r.receiptItemId == null ? null : String(r.receiptItemId)))
              .filter((v): v is string => v != null),
          ),
        ]
        if (ids.length > 0) {
          try {
            const data = await gqlFetch<{ purReceiptItems: { results: Row[] } }>(
              FETCH_RECEIPT_ITEMS,
              { ids },
            )
            if (my !== reqIdRef.current) return
            for (const ri of data.purReceiptItems.results) {
              receiptItemsRef.current.set(String(ri.id), ri)
            }
          } catch {
            /* 预热失败不挡开单:行仍可看,剩余量校验由后端兜底 */
          }
        }
        if (my !== reqIdRef.current) return
        // 行上缺的物料编号/规格/客户料号从预热缓存补齐(表格多行展示用)
        const enriched = rows.map((r) => {
          const ri =
            r.receiptItemId != null
              ? receiptItemsRef.current.get(String(r.receiptItemId))
              : undefined
          if (!ri) return r
          return {
            ...r,
            materialCode: r.materialCode ?? ri.materialCode ?? null,
            materialSpec: r.materialSpec ?? ri.materialSpec ?? null,
            customerPartNo: r.customerPartNo ?? ri.customerPartNo ?? null,
          }
        })
        setItems(enriched)
        setItemsSnapshot(enriched)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('对账条目加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }, [])

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
    <ReconciliationDrawerContext.Provider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="purReconciliations"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          receiptItemsRef.current = new Map()
        }}
        rowId={drawer?.row?.id}
        onEdit={
          drawer?.row?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          const isGift = values.reconciliationType === 'GIFT_SAMPLE'
          const headerReady = Boolean(values.companyId && values.partyType && values.partyId)
          const riGridFilter = receiptItemGridFilter(values, items)
          const docCurrency =
            items.find((r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '')
              ?.orderCurrencyCode ?? null

          // 「导入所有未对账」:按选择弹窗同口径(riGridFilter)拉全部候选,
          // 跳过已在清单的入库条目,数量默认=剩余可对账量(折行单位)
          const importAllUnreconciled = async () => {
            if (!riGridFilter) return
            setImporting(true)
            try {
              const filterLit = toGqlLiteral(riGridFilter)
              const fields =
                'id qty baseQty remainingReconcilableQty orderPrice orderBasePrice orderCurrencyCode materialCode materialName materialSpec customerPartNo unitName receiptNo'
              const candidates: Row[] = []
              let offset = 0
              for (;;) {
                const data = await gqlFetch<{
                  purReceiptItems: { count: number; results: Row[] }
                }>(
                  `query { purReceiptItems(filter: ${filterLit}, limit: 200, offset: ${offset}, sort: [{field: RECEIPT_DATE, order: ASC}]) { count results { ${fields} } } }`,
                )
                const page = data.purReceiptItems
                candidates.push(...page.results)
                // 按实际返回行数推进:limit 可能被 max_page_size 钳制(同 fetchAllRows 纪律)
                offset += page.results.length
                if (candidates.length >= page.count || page.results.length === 0) break
              }
              const listed = new Set(items.map((r) => String(r.receiptItemId)))
              const fresh = candidates.filter((ri) => !listed.has(String(ri.id)))
              if (fresh.length === 0) {
                toast.warning('没有可导入的未对账入库条目')
                return
              }
              // 清单为空时 filter 未钉币种:候选跨币种则无法保证单内同币种,先手工选一行钉住
              if (
                items.length === 0 &&
                new Set(fresh.map((ri) => String(ri.orderCurrencyCode ?? ''))).size > 1
              ) {
                toast.warning('未对账条目存在多个币种,请先手工新增一行钉住币种后再导入')
                return
              }
              let maxIdx = items.reduce((m, r) => Math.max(m, Number(r.idx) || 0), 0)
              const imported = fresh.map((ri) => {
                receiptItemsRef.current.set(String(ri.id), ri)
                const remaining = Number(ri.remainingReconcilableQty)
                const ratio = Number(ri.baseQty) > 0 ? Number(ri.qty) / Number(ri.baseQty) : 1
                // 数量默认=剩余可对账量(折行单位,6 位去尾差);金额按金额链 2 位预览,落库以后端为准
                const qty = Math.round(remaining * ratio * 1e6) / 1e6
                return {
                  id: localRowId(),
                  idx: ++maxIdx,
                  receiptItemId: ri.id,
                  qty,
                  remarks: null,
                  materialCode: ri.materialCode ?? null,
                  materialName: ri.materialName ?? null,
                  materialSpec: ri.materialSpec ?? null,
                  customerPartNo: ri.customerPartNo ?? null,
                  unitName: ri.unitName ?? null,
                  receiptNo: ri.receiptNo ?? null,
                  orderCurrencyCode: ri.orderCurrencyCode ?? null,
                  amount: previewAmount(qty, ri.orderPrice),
                  baseAmount: previewAmount(qty, ri.orderBasePrice),
                }
              })
              setItems((cur) => [...cur, ...imported])
              toast.success(`已导入 ${imported.length} 条未对账入库条目`)
            } catch (e) {
              toast.danger('导入未对账条目失败', { description: (e as Error).message })
            } finally {
              setImporting(false)
            }
          }

          // 条目录入:弹窗选入库条目后锁定回填物料/单位/币种快照;用户只填数量/行备注
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            receiptItemId: {
              order: 0,
              required: true,
              label: '入库条目',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="purReceiptItems"
                  label="入库条目"
                  dialogTitle="选择可对账入库条目"
                  placeholder={riGridFilter ? '点击选择入库条目…' : '先选齐公司与对手'}
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
                    'receiptNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, ritem) => {
                    if (id && ritem) receiptItemsRef.current.set(String(id), ritem)
                    onChange(id)
                    // 物料/单位/币种随入库条目锁定带出;collectValues 会丢 hidden 字段,
                    // 真正落行靠 transformItem 读 receiptItemsRef
                    patchItem({
                      materialCode: ritem?.materialCode ?? null,
                      materialName: ritem?.materialName ?? null,
                      materialSpec: ritem?.materialSpec ?? null,
                      customerPartNo: ritem?.customerPartNo ?? null,
                      unitName: ritem?.unitName ?? null,
                      orderCurrencyCode: ritem?.orderCurrencyCode ?? null,
                      receiptNo: ritem?.receiptNo ?? null,
                    })
                  }}
                  isDisabled={isDisabled || riGridFilter == null}
                  isRequired
                  gridFilter={riGridFilter ?? undefined}
                  gridColumns={[
                    'receiptDate',
                    'receiptNo',
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
                    orderNo: { label: '订单号' },
                    materialCode: { label: '物料编号' },
                    materialName: { label: '物料名称' },
                    customerPartNo: { label: '客户料号' },
                    unitName: { label: '单位' },
                    qty: { label: '入库数量', render: (v: unknown) => formatQty(v) || undefined },
                    reconciledQty: { label: '已对账数量', render: (v: unknown) => formatQty(v) || undefined },
                    remainingReconcilableQty: { label: '剩余可对账', render: (v: unknown) => formatQty(v) || undefined },
                    orderPrice: { label: '含税单价' },
                    orderCurrencyCode: { label: '币种' },
                  }}
                  gridDefaultSort={{ column: 'receiptDate', direction: 'descending' }}
                  gridExtraFields={[
                    'baseQty',
                    'orderBasePrice',
                    'materialSpec',
                    'reconciledQty',
                    'remainingReconcilableQty',
                  ]}
                  dialogClassName="max-w-6xl"
                  renderValue={(r) => receiptItemDisplay(r)}
                />
              ),
            },
            // 物料/单位/币种只读回显(值由入库条目 patch 写入)
            materialName: {
              order: 1,
              label: '物料',
              input: ({ values: iv }) => {
                const code = iv.materialCode != null ? String(iv.materialCode) : ''
                const name = iv.materialName != null ? String(iv.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '选入库条目后自动带出'
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
                  value={iv.unitName != null ? String(iv.unitName) : '选入库条目后自动带出'}
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
                  value={iv.orderCurrencyCode != null ? String(iv.orderCurrencyCode) : '—'}
                />
              ),
            },
            qty: { order: 4, cols: 6, required: true, label: '对账数量' },
            baseQty: {
              order: 5,
              cols: 6,
              label: '折算数量',
              input: ({ value }) => <LockedNumber label="折算数量(默认单位)" value={value} />,
            },
            amount: {
              order: 6,
              cols: 6,
              label: '金额(原币含税)',
              input: ({ value, values: iv }) => {
                const ritem =
                  iv.receiptItemId != null
                    ? receiptItemsRef.current.get(String(iv.receiptItemId))
                    : undefined
                const preview =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ritem?.orderPrice)
                return <LockedNumber label="金额(原币含税,数量×快照单价)" value={preview} />
              },
            },
            baseAmount: {
              order: 7,
              cols: 6,
              label: '本币金额',
              input: ({ value, values: iv }) => {
                const ritem =
                  iv.receiptItemId != null
                    ? receiptItemsRef.current.get(String(iv.receiptItemId))
                    : undefined
                const preview =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ritem?.orderBasePrice)
                return <LockedNumber label="本币金额(含税)" value={preview} />
              },
            },
            remarks: { order: 8, label: '行备注' },
            // 手改快照入口彻底隐藏(值仍随入库条目写入草稿行)
            materialCode: { visible: () => false },
            materialSpec: { visible: () => false },
            customerPartNo: { visible: () => false },
            receiptNo: { visible: () => false },
          }

          const totalAmount = items.reduce((acc, r) => acc + (Number(r.amount) || 0), 0)
          const totalBaseAmount = items.reduce((acc, r) => acc + (Number(r.baseAmount) || 0), 0)
          const itemsReadOnly =
            mode === 'view' ||
            (row != null && row.status !== 'DRAFT') ||
            (mode !== 'create' && !detailLoaded)

          return (
            <>
              <CompanyDefaultSync
                mode={mode}
                values={values}
                patchValues={patchValues}
                defaultId={createDefaultCompany}
              />
              <ReconciliationAccountDefaultSync
                key={`acct-${drawer?.row?.id ?? 'create'}-${reqIdRef.current}`}
                mode={mode}
                companyId={(values.companyId as string | null) ?? null}
                patchValues={patchValues}
              />
              {/* key 随开抽屉世代变,保证每次打开重新布防基线 */}
              <ItemsResetGuard
                key={`${drawer?.row?.id ?? 'create'}-${reqIdRef.current}`}
                mode={mode}
                row={row}
                values={values}
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
                        <span className="text-xs text-muted">先选齐公司、对手类型与对手</span>
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
                drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
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
                  receiptNo: { label: '入库单号' },
                  materialName: {
                    label: '物料',
                    // 多行展示编号/名称/规格/客户料号,避免横向撑宽
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: (_v, r) => {
                      const code = r.materialCode != null ? String(r.materialCode) : ''
                      const name = r.materialName != null ? String(r.materialName) : ''
                      const title = [code, name].filter(Boolean).join(' ')
                      if (!title && r.materialSpec == null && r.customerPartNo == null)
                        return undefined
                      const spec =
                        r.materialSpec != null && r.materialSpec !== ''
                          ? String(r.materialSpec)
                          : null
                      const cpn =
                        r.customerPartNo != null && r.customerPartNo !== ''
                          ? String(r.customerPartNo)
                          : null
                      return (
                        <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
                          {title ? <span className="truncate font-medium">{title}</span> : null}
                          {spec ? (
                            <span className="truncate text-xs text-muted" title={spec}>
                              规格 {spec}
                            </span>
                          ) : null}
                          {cpn ? (
                            <span className="truncate text-xs text-muted" title={cpn}>
                              客户料号 {cpn}
                            </span>
                          ) : null}
                        </div>
                      )
                    },
                  },
                  unitName: { label: '单位' },
                  qty: { render: (v) => formatQty(v) || undefined },
                  baseQty: { label: '折算数量', render: (v) => formatQty(v) || undefined },
                  amount: { label: '金额(原币)', render: (v) => formatAmount(v) || undefined },
                  baseAmount: {
                    label: '本币金额',
                    render: (v) => formatAmount(v) || undefined,
                  },
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, curItems, editing) => {
                  if (!vals.receiptItemId) return '请选择入库条目'
                  if (
                    curItems.some(
                      (r) =>
                        r.id !== editing?.id &&
                        r.receiptItemId != null &&
                        String(r.receiptItemId) === String(vals.receiptItemId),
                    )
                  )
                    return '该入库条目已在清单中'
                  if (!(Number(vals.qty) > 0)) return '对账数量必须大于零'
                  // 单内同币种:以首个他行币种为基准(弹窗已过滤,这里双保险)
                  const ritem = receiptItemsRef.current.get(String(vals.receiptItemId))
                  const rowCurrency =
                    ritem?.orderCurrencyCode ?? vals.orderCurrencyCode ?? editing?.orderCurrencyCode
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
                  const ritem =
                    vals.receiptItemId != null
                      ? receiptItemsRef.current.get(String(vals.receiptItemId))
                      : undefined
                  const pick = (key: string) =>
                    ritem?.[key] ?? editing?.[key] ?? vals[key] ?? null
                  const qty = vals.qty
                  // hidden 字段不会进 collectValues:快照以缓存或编辑行补全;
                  // 金额按金额链预算 2 位预览(保存时后端重算为准)
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    materialCode: pick('materialCode'),
                    materialName: pick('materialName'),
                    materialSpec: pick('materialSpec'),
                    customerPartNo: pick('customerPartNo'),
                    unitName: pick('unitName'),
                    receiptNo: pick('receiptNo'),
                    orderCurrencyCode: pick('orderCurrencyCode'),
                    amount:
                      previewAmount(qty, ritem?.orderPrice) ??
                      (editing && String(editing.receiptItemId) === String(vals.receiptItemId)
                        ? editing.amount
                        : null),
                    baseAmount:
                      previewAmount(qty, ritem?.orderBasePrice) ??
                      (editing && String(editing.receiptItemId) === String(vals.receiptItemId)
                        ? editing.baseAmount
                        : null),
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
                isDisabled={mode === 'view' || (row != null && row.status !== 'DRAFT')}
              />
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const data = await gqlFetch<{ createPurReconciliation: MutationResult }>(
              CREATE_RECONCILIATION,
              { input: values },
            )
            const res = data.createPurReconciliation
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const reconciliationId = res!.result!.id
            const itemErrors = await persistItems(reconciliationId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('采购对账单已创建,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('采购对账单已创建')
            }
            savedId = reconciliationId
          } else {
            const data = await gqlFetch<{ updatePurReconciliation: MutationResult }>(
              UPDATE_RECONCILIATION,
              { id: drawer!.row!.id, input: values },
            )
            const res = data.updatePurReconciliation
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(drawer!.row!.id, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('采购对账单已更新,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('采购对账单已更新')
            }
            savedId = drawer!.row!.id
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purReconciliations'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purReconciliationItems'] })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'purReconciliations'] })
          return savedId
        }}
      />
    </ReconciliationDrawerContext.Provider>
  )
}
