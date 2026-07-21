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
import { Input, Label, NumberField, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { gqlEnum } from '~/components/synie-data-grid/query'
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
  'id idx deliveryNo materialName unitName qty baseQty amount baseAmount remarks'

const AUDIT_COLUMNS: AuditDocConfig['columns'] = [
  { key: 'deliveryNo', label: '发货单号' },
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

// 「客户确认」(常规单)确认弹窗:列出整单条目核对,与赠送/样品单「结单审核」同一套(见 scm/-audit-doc)
export const reconciliationConfirmConfig = {
  docLabel: '销售对账单',
  mutation: 'confirmSalReconciliation',
  itemsResource: 'salReconciliationItems',
  docIdField: 'reconciliationId',
  itemFields: AUDIT_ITEM_FIELDS,
  columns: AUDIT_COLUMNS,
} satisfies AuditDocConfig

// 「结单审核」(赠送/样品单)确认弹窗
export const reconciliationAuditConfig = {
  docLabel: '销售对账单',
  mutation: 'auditSalReconciliation',
  itemsResource: 'salReconciliationItems',
  docIdField: 'reconciliationId',
  itemFields: AUDIT_ITEM_FIELDS,
  columns: AUDIT_COLUMNS,
} satisfies AuditDocConfig

const ReconciliationDrawerContext = createContext<OpenReconciliationDrawer>(() => {})

export function useReconciliationDrawer(): OpenReconciliationDrawer {
  return useContext(ReconciliationDrawerContext)
}

const CREATE_RECONCILIATION = `
  mutation ($input: CreateSalReconciliationInput!) {
    createSalReconciliation(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_RECONCILIATION = `
  mutation ($id: ID!, $input: UpdateSalReconciliationInput!) {
    updateSalReconciliation(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 只取快照/calculation 与 id 字段,不 join material/delivery——
// 嵌套加载会走对方资源权限,无 read 时 GraphQL 非空关系变 null 整查询失败(同发货抽屉先例)。
// 物料编号/规格/客户料号不在行 calculation 上,由发货条目预热缓存按 deliveryItemId 补(见 openDrawer)。
const FETCH_ITEMS = `
  query ($reconciliationId: ID!) {
    salReconciliationItems(
      filter: {reconciliationId: {eq: $reconciliationId}}
      sort: [{field: IDX, order: ASC}]
      limit: 200
      offset: 0
    ) {
      results {
        id idx deliveryItemId qty baseQty amount baseAmount remarks
        materialName unitName deliveryNo orderCurrencyCode
      }
    }
  }
`
// 编辑态预热发货条目缓存:剩余可对账量/快照单价/币种等,存量行不点选发货条目也能过校验/回填
const FETCH_DELIVERY_ITEMS = `
  query ($ids: [ID!]!) {
    salDeliveryItems(filter: {id: {in: $ids}}, limit: 200, offset: 0) {
      results {
        id qty baseQty reconciledQty remainingReconcilableQty
        orderNo orderPrice orderBasePrice orderCurrencyCode
        materialCode materialName materialSpec customerPartNo unitName deliveryNo
      }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateSalReconciliationItemInput!) {
    createSalReconciliationItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateSalReconciliationItemInput!) {
    updateSalReconciliationItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroySalReconciliationItem(id: $id) { errors { message } }
  }
`

/** 提交 mutation:金额/baseQty 由后端按金额链与折算比例算(不可手改) */
function itemInput(row: Row) {
  return {
    idx: row.idx,
    deliveryItemId: row.deliveryItemId,
    qty: row.qty,
    remarks: row.remarks ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['idx', 'deliveryItemId', 'qty', 'remarks'] as const

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
    const data = await gqlFetch<{ destroySalReconciliationItem: MutationResult }>(DESTROY_ITEM, {
      id: old.id,
    })
    collect(old.idx, data.destroySalReconciliationItem?.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createSalReconciliationItem: MutationResult }>(CREATE_ITEM, {
        input: { reconciliationId, ...itemInput(row) },
      })
      collect(row.idx, data.createSalReconciliationItem?.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updateSalReconciliationItem: MutationResult }>(UPDATE_ITEM, {
        id: row.id,
        input: itemInput(row),
      })
      collect(row.idx, data.updateSalReconciliationItem?.errors)
    }
  }
  return errors
}

/**
 * 科目候选 filter。枚举值必须是 GraphQL enum 裸 token(不可 JSON 字符串)。
 * 借方角色不限(常规=发货贷方口径,赠送/样品=费用损失);贷方强制未开票应收(同后端校验)。
 */
function accountFilter(companyId: string | null, roleEnum?: string): string | undefined {
  if (!companyId) return undefined
  const base = `companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}`
  if (roleEnum) return `{${base}, role: {eq: ${roleEnum}}}`
  return `{${base}}`
}

/**
 * 新建态:公司选定/变更时整组覆盖借贷科目为该公司默认(与后端 FillDefaultAccounts 同口径:
 * 对账单借方 ← 默认发货贷方,对账单贷方 ← 默认发货借方;无默认则清空)。
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
        debitAccountId: row?.deliveryCreditAccountId ?? null,
        creditAccountId: row?.deliveryDebitAccountId ?? null,
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
  const debitLabel = isGift ? '借方科目(费用/损失)' : '借方科目(发货贷方口径)'
  const debit = values.debitAccountId == null || values.debitAccountId === '' ? null : String(values.debitAccountId)
  const credit =
    values.creditAccountId == null || values.creditAccountId === '' ? null : String(values.creditAccountId)

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t border-separator pt-4 lg:grid-cols-2">
      <RemoteSelect
        resource="basAccounts"
        label={debitLabel}
        placeholder={companyId ? `选择${debitLabel}…` : '先选择公司'}
        value={debit}
        onChange={(id) => patchValues({ debitAccountId: id })}
        isDisabled={isDisabled || !companyId || mode === 'view'}
        isRequired={mode !== 'view'}
        filter={accountFilter(companyId)}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
      <RemoteSelect
        resource="basAccounts"
        label="贷方科目(未开票应收)"
        placeholder={companyId ? '选择未开票应收科目…' : '先选择公司'}
        value={credit}
        onChange={(id) => patchValues({ creditAccountId: id })}
        isDisabled={isDisabled || !companyId || mode === 'view'}
        isRequired={mode !== 'view'}
        filter={accountFilter(companyId, 'UNBILLED_RECEIVABLE')}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
    </div>
  )
}

/**
 * 可勾发货条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核发货 2. 公司/对手与对账头一致 3. 剩余可对账量 > 0 4. 单内同币种(已有行时)
 * 5. 常规单:禁零金额行、禁样品订单来源(嵌套 orderItem.order;后端均另有强校验)
 * 枚举值用 gqlEnum 包装(不可 JSON 字符串)。
 */
function deliveryItemGridFilter(
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
      { deliveryStatus: { eq: gqlEnum('AUDITED') } },
      { companyId: { eq: String(companyId) } },
      { partyType: { eq: gqlEnum(String(partyType)) } },
      { partyId: { eq: String(partyId) } },
      { remainingReconcilableQty: { greaterThan: '0' } },
      ...(currency ? [{ orderCurrencyCode: { eq: String(currency) } }] : []),
      ...(isRegular
        ? [
            { orderPrice: { greaterThan: '0' } },
            { orderItem: { order: { orderType: { notEq: gqlEnum('SAMPLE') } } } },
          ]
        : []),
    ],
  }
}

function deliveryItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining = r.remainingReconcilableQty != null ? String(r.remainingReconcilableQty) : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem = remaining != null ? `剩余可对账${remaining}${unit ? `(默认单位折算,行单位${unit})` : ''}` : ''
  const deliveryNo = r.deliveryNo != null && r.deliveryNo !== '' ? String(r.deliveryNo) : null
  return [material || '发货条目', rem, deliveryNo].filter(Boolean).join(' · ')
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
  const [filters] = useState<FilterState>({})
  // 发货条目缓存:选择时写入完整行,validateItem/transformItem 带剩余量与快照价
  const deliveryItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const companies = useQuery({
    queryKey: ['salReconciliations', 'companies'],
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
    deliveryItemsRef.current = new Map()
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    const reconciliationId = reconciliation?.id
    // 防前端把 String(undefined) 当成 uuid 过滤(Invalid filter value "undefined")
    if (reconciliationId == null || reconciliationId === '' || reconciliationId === 'undefined') {
      toast.danger('无法打开销售对账单', { description: '缺少对账单 id' })
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{ salReconciliationItems: { results: Row[] } }>(FETCH_ITEMS, {
      reconciliationId,
    })
      .then(async (d) => {
        if (my !== reqIdRef.current) return
        const rows = d.salReconciliationItems.results
        // 编辑态预热缓存:按行上发货条目 id 取剩余可对账量/快照价/币种
        const ids = [
          ...new Set(
            rows
              .map((r) => (r.deliveryItemId == null ? null : String(r.deliveryItemId)))
              .filter((v): v is string => v != null),
          ),
        ]
        if (ids.length > 0) {
          try {
            const data = await gqlFetch<{ salDeliveryItems: { results: Row[] } }>(
              FETCH_DELIVERY_ITEMS,
              { ids },
            )
            if (my !== reqIdRef.current) return
            for (const di of data.salDeliveryItems.results) {
              deliveryItemsRef.current.set(String(di.id), di)
            }
          } catch {
            /* 预热失败不挡开单:行仍可看,剩余量校验由后端兜底 */
          }
        }
        if (my !== reqIdRef.current) return
        // 行上缺的物料编号/规格/客户料号从预热缓存补齐(表格多行展示用)
        const enriched = rows.map((r) => {
          const di =
            r.deliveryItemId != null
              ? deliveryItemsRef.current.get(String(r.deliveryItemId))
              : undefined
          if (!di) return r
          return {
            ...r,
            materialCode: r.materialCode ?? di.materialCode ?? null,
            materialSpec: r.materialSpec ?? di.materialSpec ?? null,
            customerPartNo: r.customerPartNo ?? di.customerPartNo ?? null,
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

  const baseCfg = drawerConfig('salReconciliations')
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
        resource="salReconciliations"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          deliveryItemsRef.current = new Map()
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
          const diGridFilter = deliveryItemGridFilter(values, items)
          const docCurrency =
            items.find((r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '')
              ?.orderCurrencyCode ?? null

          // 条目录入:弹窗选发货条目后锁定回填物料/单位/币种快照;用户只填数量/行备注
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            deliveryItemId: {
              order: 0,
              required: true,
              label: '发货条目',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="salDeliveryItems"
                  label="发货条目"
                  dialogTitle="选择可对账发货条目"
                  placeholder={diGridFilter ? '点击选择发货条目…' : '先选齐公司与对手'}
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
                    'deliveryNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, ditem) => {
                    if (id && ditem) deliveryItemsRef.current.set(String(id), ditem)
                    onChange(id)
                    // 物料/单位/币种随发货条目锁定带出;collectValues 会丢 hidden 字段,
                    // 真正落行靠 transformItem 读 deliveryItemsRef
                    patchItem({
                      materialCode: ditem?.materialCode ?? null,
                      materialName: ditem?.materialName ?? null,
                      materialSpec: ditem?.materialSpec ?? null,
                      customerPartNo: ditem?.customerPartNo ?? null,
                      unitName: ditem?.unitName ?? null,
                      orderCurrencyCode: ditem?.orderCurrencyCode ?? null,
                      deliveryNo: ditem?.deliveryNo ?? null,
                    })
                  }}
                  isDisabled={isDisabled || diGridFilter == null}
                  isRequired
                  gridFilter={diGridFilter ?? undefined}
                  gridColumns={[
                    'deliveryDate',
                    'deliveryNo',
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
                    deliveryDate: { label: '发货日期' },
                    deliveryNo: { label: '发货单号' },
                    orderNo: { label: '订单号' },
                    materialCode: { label: '物料编号' },
                    materialName: { label: '物料名称' },
                    customerPartNo: { label: '客户料号' },
                    unitName: { label: '单位' },
                    qty: { label: '发货数量' },
                    reconciledQty: { label: '已对账数量' },
                    remainingReconcilableQty: { label: '剩余可对账' },
                    orderPrice: { label: '含税单价' },
                    orderCurrencyCode: { label: '币种' },
                  }}
                  gridDefaultSort={{ column: 'deliveryDate', direction: 'descending' }}
                  gridExtraFields={[
                    'baseQty',
                    'orderBasePrice',
                    'materialSpec',
                    'reconciledQty',
                    'remainingReconcilableQty',
                  ]}
                  dialogClassName="max-w-6xl"
                  renderValue={(r) => deliveryItemDisplay(r)}
                />
              ),
            },
            // 物料/单位/币种只读回显(值由发货条目 patch 写入)
            materialName: {
              order: 1,
              label: '物料',
              input: ({ values: iv }) => {
                const code = iv.materialCode != null ? String(iv.materialCode) : ''
                const name = iv.materialName != null ? String(iv.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '选发货条目后自动带出'
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
                  value={iv.unitName != null ? String(iv.unitName) : '选发货条目后自动带出'}
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
                const ditem =
                  iv.deliveryItemId != null
                    ? deliveryItemsRef.current.get(String(iv.deliveryItemId))
                    : undefined
                const preview =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ditem?.orderPrice)
                return <LockedNumber label="金额(原币含税,数量×快照单价)" value={preview} />
              },
            },
            baseAmount: {
              order: 7,
              cols: 6,
              label: '本币金额',
              input: ({ value, values: iv }) => {
                const ditem =
                  iv.deliveryItemId != null
                    ? deliveryItemsRef.current.get(String(iv.deliveryItemId))
                    : undefined
                const preview =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ditem?.orderBasePrice)
                return <LockedNumber label="本币金额(含税)" value={preview} />
              },
            },
            remarks: { order: 8, label: '行备注' },
            // 手改快照入口彻底隐藏(值仍随发货条目写入草稿行)
            materialCode: { visible: () => false },
            materialSpec: { visible: () => false },
            customerPartNo: { visible: () => false },
            deliveryNo: { visible: () => false },
          }

          const totalAmount = items.reduce((acc, r) => acc + (Number(r.amount) || 0), 0)
          const totalBaseAmount = items.reduce((acc, r) => acc + (Number(r.baseAmount) || 0), 0)

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
                resource="salReconciliationItems"
                label="对账条目"
                items={items}
                onChange={setItems}
                readOnly={
                  mode === 'view' ||
                  (row != null && row.status !== 'DRAFT') ||
                  (mode !== 'create' && !detailLoaded)
                }
                canCreate={headerReady}
                toolbar={
                  mode !== 'view' && !headerReady ? (
                    <span className="text-xs text-muted">先选齐公司、对手类型与对手</span>
                  ) : undefined
                }
                drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
                exclude={[
                  'reconciliationId',
                  'companyId',
                  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
                  'reconciliationNo',
                  'reconciliationStatus',
                  'deliveryDate',
                  // deliveryNo/materialCode/materialSpec/customerPartNo 仍在 fields 里
                  // visible:false 以保留提交值
                ]}
                columns={[
                  'idx',
                  'deliveryNo',
                  'materialName',
                  'unitName',
                  'qty',
                  'baseQty',
                  'amount',
                  'baseAmount',
                  'remarks',
                ]}
                overrides={{
                  deliveryNo: { label: '发货单号' },
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
                  baseQty: { label: '折算数量' },
                  amount: { label: '金额(原币)', render: (v) => formatAmount(v) || undefined },
                  baseAmount: {
                    label: '本币金额',
                    render: (v) => formatAmount(v) || undefined,
                  },
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, curItems, editing) => {
                  if (!vals.deliveryItemId) return '请选择发货条目'
                  if (
                    curItems.some(
                      (r) =>
                        r.id !== editing?.id &&
                        r.deliveryItemId != null &&
                        String(r.deliveryItemId) === String(vals.deliveryItemId),
                    )
                  )
                    return '该发货条目已在清单中'
                  if (!(Number(vals.qty) > 0)) return '对账数量必须大于零'
                  // 单内同币种:以首个他行币种为基准(弹窗已过滤,这里双保险)
                  const ditem = deliveryItemsRef.current.get(String(vals.deliveryItemId))
                  const rowCurrency =
                    ditem?.orderCurrencyCode ?? vals.orderCurrencyCode ?? editing?.orderCurrencyCode
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
                  // 常规单禁零金额行(样品来源弹窗已滤,金额这里双保险;后端均强校验)
                  if (!isGift && ditem && !(Number(ditem.orderPrice) > 0))
                    return '常规对账单不可勾选零金额条目'
                  // 对账数量 ≤ 剩余可对账量(剩余是默认单位口径,按行单位比例折算比较;后端权威校验)
                  if (ditem?.remainingReconcilableQty != null) {
                    const remaining = Number(ditem.remainingReconcilableQty)
                    const ratio =
                      Number(ditem.baseQty) > 0
                        ? Number(ditem.qty) / Number(ditem.baseQty)
                        : 1
                    const remainingRow = remaining * ratio
                    if (Number(vals.qty) > remainingRow + 1e-9)
                      return `超出剩余可对账量(按行单位约 ${remainingRow.toFixed(4)} ${String(ditem.unitName ?? '')})`
                  }
                }}
                transformItem={(vals, editing) => {
                  const ditem =
                    vals.deliveryItemId != null
                      ? deliveryItemsRef.current.get(String(vals.deliveryItemId))
                      : undefined
                  const pick = (key: string) =>
                    ditem?.[key] ?? editing?.[key] ?? vals[key] ?? null
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
                    deliveryNo: pick('deliveryNo'),
                    orderCurrencyCode: pick('orderCurrencyCode'),
                    amount:
                      previewAmount(qty, ditem?.orderPrice) ??
                      (editing && String(editing.deliveryItemId) === String(vals.deliveryItemId)
                        ? editing.amount
                        : null),
                    baseAmount:
                      previewAmount(qty, ditem?.orderBasePrice) ??
                      (editing && String(editing.deliveryItemId) === String(vals.deliveryItemId)
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
            const data = await gqlFetch<{ createSalReconciliation: MutationResult }>(
              CREATE_RECONCILIATION,
              { input: values },
            )
            const res = data.createSalReconciliation
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const reconciliationId = res!.result!.id
            const itemErrors = await persistItems(reconciliationId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('销售对账单已创建,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('销售对账单已创建')
            }
            savedId = reconciliationId
          } else {
            const data = await gqlFetch<{ updateSalReconciliation: MutationResult }>(
              UPDATE_RECONCILIATION,
              { id: drawer!.row!.id, input: values },
            )
            const res = data.updateSalReconciliation
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(drawer!.row!.id, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('销售对账单已更新,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('销售对账单已更新')
            }
            savedId = drawer!.row!.id
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salReconciliations'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salReconciliationItems'] })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'salReconciliations'] })
          return savedId
        }}
      />
    </ReconciliationDrawerContext.Provider>
  )
}
