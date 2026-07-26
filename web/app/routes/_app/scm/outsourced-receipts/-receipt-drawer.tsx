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
import { Input, Label, ListBox, NumberField, Select, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { queryOutsourcedWarehouses } from '~/lib/resources/inventory'
import { purchaseOrderItemClient } from '~/lib/resources/orders'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { auditMaterialCell, type AuditDocConfig } from '../-audit-doc'
import { CompanyDefaultSync, WarehouseRemoteSelect, defaultCompanyId } from '../-stock-doc'
import { fetchCompanyAccountDefaults } from '../settings/-company-account-defaults'

export interface ReceiptRef {
  id: string
  status?: unknown
}

export type OpenReceiptDrawer = (mode: DrawerMode, receipt: ReceiptRef | null) => void

// 「审核整单」确认弹窗配置:条目页行操作与入库单页「审核」动作共用(见 scm/-audit-doc)
export const receiptAuditConfig = {
  docLabel: '委外入库单',
  mutation: 'auditPurOutsourcedReceipt',
  itemsResource: 'purOutsourcedReceiptItems',
  docIdField: 'receiptId',
  itemFields:
    'id idx materialCode materialName materialSpec customerPartNo unitName qty baseQty remarks',
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ key: 'customerPartNo', label: '客户料号' }),
    },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '入库数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

const ReceiptDrawerContext = createContext<OpenReceiptDrawer>(() => {})

export function useReceiptDrawer(): OpenReceiptDrawer {
  return useContext(ReceiptDrawerContext)
}

const CREATE_RECEIPT = `
  mutation ($input: CreatePurOutsourcedReceiptInput!) {
    createPurOutsourcedReceipt(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_RECEIPT = `
  mutation ($id: ID!, $input: UpdatePurOutsourcedReceiptInput!) {
    updatePurOutsourcedReceipt(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 只取快照与 id 字段,不 join material/unit/warehouse——
// 嵌套加载会走对方资源权限,无 read 时 GraphQL 非空关系变 null 整查询失败。
const FETCH_DETAIL = `
  query ($receiptId: ID!) {
    purOutsourcedReceiptItems(
      filter: {receiptId: {eq: $receiptId}}
      sort: [{field: IDX, order: ASC}]
      limit: 200
      offset: 0
    ) {
      results {
        id idx orderItemId materialId unitId qty baseQty warehouseId remarks
        materialCode materialName materialSpec customerPartNo unitName
        orderNo orderQty orderUnitName
      }
    }
    purOutsourcedReceiptItemMaterials(
      filter: {receiptItem: {receiptId: {eq: $receiptId}}}
      sort: [{field: IDX, order: ASC}]
      limit: 500
      offset: 0
    ) {
      results {
        id idx receiptItemId orderItemMaterialId qty baseQty outsourcedWarehouseId remarks
        materialCode materialName materialSpec unitName orderNo
      }
    }
    purOutsourcedReceiptItemByproducts(
      filter: {receiptItem: {receiptId: {eq: $receiptId}}}
      sort: [{field: IDX, order: ASC}]
      limit: 500
      offset: 0
    ) {
      results {
        id idx receiptItemId orderItemByproductId qty baseQty warehouseId remarks
        materialCode materialName materialSpec unitName orderNo
      }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreatePurOutsourcedReceiptItemInput!) {
    createPurOutsourcedReceiptItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdatePurOutsourcedReceiptItemInput!) {
    updatePurOutsourcedReceiptItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyPurOutsourcedReceiptItem(id: $id) { errors { message } }
  }
`
const CREATE_MATERIAL_ROW = `
  mutation ($input: CreatePurOutsourcedReceiptItemMaterialInput!) {
    createPurOutsourcedReceiptItemMaterial(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_MATERIAL_ROW = `
  mutation ($id: ID!, $input: UpdatePurOutsourcedReceiptItemMaterialInput!) {
    updatePurOutsourcedReceiptItemMaterial(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_MATERIAL_ROW = `
  mutation ($id: ID!) {
    destroyPurOutsourcedReceiptItemMaterial(id: $id) { errors { message } }
  }
`
const CREATE_BYPRODUCT_ROW = `
  mutation ($input: CreatePurOutsourcedReceiptItemByproductInput!) {
    createPurOutsourcedReceiptItemByproduct(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_BYPRODUCT_ROW = `
  mutation ($id: ID!, $input: UpdatePurOutsourcedReceiptItemByproductInput!) {
    updatePurOutsourcedReceiptItemByproduct(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_BYPRODUCT_ROW = `
  mutation ($id: ID!) {
    destroyPurOutsourcedReceiptItemByproduct(id: $id) { errors { message } }
  }
`

function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 提交 mutation:物料/单位由订单条目锁定带出,后端再快照与折算 */
function itemInput(row: Row) {
  return {
    idx: row.idx,
    orderItemId: row.orderItemId,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    warehouseId: row.warehouseId,
    remarks: row.remarks ?? null,
  }
}

function materialRowInput(row: Row) {
  return {
    idx: row.idx,
    receiptItemId: row.receiptItemId,
    orderItemMaterialId: row.orderItemMaterialId,
    qty: row.qty,
    outsourcedWarehouseId: row.outsourcedWarehouseId ?? null,
    remarks: row.remarks ?? null,
  }
}

function byproductRowInput(row: Row) {
  return {
    idx: row.idx,
    receiptItemId: row.receiptItemId,
    orderItemByproductId: row.orderItemByproductId,
    qty: row.qty,
    warehouseId: row.warehouseId ?? null,
    remarks: row.remarks ?? null,
  }
}

const ITEM_COMPARE_KEYS = [
  'idx',
  'orderItemId',
  'materialId',
  'unitId',
  'qty',
  'warehouseId',
  'remarks',
] as const
const MATERIAL_ROW_COMPARE_KEYS = ['idx', 'orderItemMaterialId', 'qty', 'outsourcedWarehouseId', 'remarks'] as const
const BYPRODUCT_ROW_COMPARE_KEYS = ['idx', 'orderItemByproductId', 'qty', 'warehouseId', 'remarks'] as const

function changedBy(keys: readonly string[]) {
  return (before: Row, after: Row): boolean =>
    keys.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

const itemChanged = changedBy(ITEM_COMPARE_KEYS)
const materialRowChanged = changedBy(MATERIAL_ROW_COMPARE_KEYS)
const byproductRowChanged = changedBy(BYPRODUCT_ROW_COMPARE_KEYS)

interface MutationResult {
  result?: { id: string } | null
  errors: { message: string }[] | null
}

/**
 * 行持久化通用件:先删(跳过将随父条目级联删的行)、再增、后改。
 * deletedItemIds=本次被删的入库条目 id——其扣减/副产物行由 DB 级联清理,不必(也不能)逐行删。
 */
async function persistRows(opts: {
  current: Row[]
  snapshot: Row[]
  deletedItemIds: Set<string>
  inputOf: (row: Row) => Record<string, unknown>
  changed: (before: Row, after: Row) => boolean
  createMutation: string
  updateMutation: string
  destroyMutation: string
  createKey: string
  updateKey: string
  destroyKey: string
}): Promise<string[]> {
  const errors: string[] = []
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(opts.current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of opts.snapshot) {
    if (currentIds.has(old.id)) continue
    if (opts.deletedItemIds.has(String(old.receiptItemId ?? ''))) continue
    const data = await gqlFetch<Record<string, MutationResult>>(opts.destroyMutation, {
      id: old.id,
    })
    collect(old.idx, data[opts.destroyKey]?.errors)
  }

  for (const row of opts.current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<Record<string, MutationResult>>(opts.createMutation, {
        input: opts.inputOf(row),
      })
      collect(row.idx, data[opts.createKey]?.errors)
      continue
    }
    const old = opts.snapshot.find((s) => s.id === row.id)
    if (old && opts.changed(old, row)) {
      const data = await gqlFetch<Record<string, MutationResult>>(opts.updateMutation, {
        id: row.id,
        input: opts.inputOf(row),
      })
      collect(row.idx, data[opts.updateKey]?.errors)
    }
  }
  return errors
}

/** 科目候选 filter。枚举值必须是 GraphQL enum 裸 token(不可 JSON 字符串)。 */
function accountFilter(companyId: string | null, roleEnum?: string): string | undefined {
  if (!companyId) return undefined
  const base = `companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}`
  if (roleEnum) return `{${base}, role: {eq: ${roleEnum}}}`
  return `{${base}}`
}

/**
 * 新建态:公司选定/变更时整组覆盖借贷科目为该公司默认(无默认则清空)。
 * 编辑态公司锁死,不重灌。
 */
function ReceiptAccountDefaultSync({
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
        debitAccountId: row?.receiptDebitAccountId ?? null,
        creditAccountId: row?.receiptCreditAccountId ?? null,
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, companyId])

  return null
}

function ReceiptAccountFooter({
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
  const debit =
    values.debitAccountId == null || values.debitAccountId === '' ? null : String(values.debitAccountId)
  const credit =
    values.creditAccountId == null || values.creditAccountId === '' ? null : String(values.creditAccountId)

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t border-separator pt-4 lg:grid-cols-2">
      <RemoteSelect
        resource="basAccounts"
        label="借方科目"
        placeholder={companyId ? '选择借方科目(存货/费用等)…' : '先选择公司'}
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
        label="贷方科目(未开票应付)"
        placeholder={companyId ? '选择未开票应付科目…' : '先选择公司'}
        value={credit}
        onChange={(id) => patchValues({ creditAccountId: id })}
        isDisabled={isDisabled || !companyId || mode === 'view'}
        isRequired={mode !== 'view'}
        filter={accountFilter(companyId, 'UNBILLED_PAYABLE')}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
    </div>
  )
}

/**
 * 有效委外订单条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核委外订单 2. 公司/对手与入库头一致 3. 未收数量 > 0
 * 使用 REST FilterState，权限与公司/对手/剩余数量条件由服务端白名单解释。
 */
function orderItemGridFilter(values: Record<string, unknown>): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  return {
    orderStatus: { kind: 'enum', values: ['AUDITED'] },
    orderIsOutsourced: { kind: 'bool', eq: true },
    companyId: { kind: 'fk', op: 'in', values: [String(companyId)], labels: [] },
    partyType: { kind: 'enum', values: [String(partyType)] },
    partyId: {
      kind: 'polyFk',
      op: 'in',
      variant: String(partyType),
      values: [String(partyId)],
      labels: [],
    },
    remainingBaseQty: { kind: 'number', op: 'gt', value: '0' },
  }
}

function orderItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  return [code, name].filter(Boolean).join(' ') || '订单条目'
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
 * 外协仓选择器:通过 warehouse REST 按协作方过滤。
 * 未选齐对手类型与对手时禁用。候选少(一对手几个仓),一次拉全量不做远程搜索。
 */
function OutsourcedWarehouseSelect({
  value,
  onChange,
  isDisabled,
  partyType,
  partyId,
  label = '外协仓',
}: {
  value: unknown
  onChange: (v: string | null) => void
  isDisabled: boolean
  partyType: string | null
  partyId: string | null
  label?: string
}) {
  const ready = Boolean(partyType && partyId)
  const warehouses = useQuery({
    queryKey: ['outsourcedWarehouses', partyType, partyId],
    enabled: ready,
    queryFn: () =>
      queryOutsourcedWarehouses(partyType as 'SUPPLIER' | 'COMPANY', partyId!),
  })

  const strValue = value == null || value === '' ? null : String(value)
  const selected = (warehouses.data ?? []).find((w) => w.id === strValue)

  return (
    <Select
      isDisabled={isDisabled || !ready}
      value={strValue}
      onChange={(v) => onChange(v === '' ? null : (v as string | null))}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder ? (
              <span className="text-muted">
                {ready ? '选择外协仓…' : '先选齐对手类型与对手'}
              </span>
            ) : selected ? (
              String(selected.name)
            ) : (
              (defaultChildren ?? String(strValue).slice(0, 8))
            )
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {(warehouses.data ?? []).map((w) => (
            <ListBox.Item key={w.id} id={String(w.id)} textValue={String(w.name)}>
              {String(w.name)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

/**
 * 头关键字段变更清行:公司/对手类型/对手任一变则清空条目草稿
 * (与采购入库 ItemsResetGuard 同构;edit 等行主数据回填后再布防)。
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
    [v.companyId, v.partyType, v.partyId].map((x) => String(x ?? '')).join('|')
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

export function ReceiptDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: ReceiptRef | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [materialRows, setMaterialRows] = useState<Row[]>([])
  const [materialRowsSnapshot, setMaterialRowsSnapshot] = useState<Row[]>([])
  const [byproductRows, setByproductRows] = useState<Row[]>([])
  const [byproductRowsSnapshot, setByproductRowsSnapshot] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [filters] = useState<FilterState>({})
  // 订单条目缓存:选择时写入完整行,transformItem 带出快照名
  const orderItemsRef = useRef(new Map<string, Row>())
  // 清单行缓存(材料/副产物共用):选择时写入完整行,带出材料/单位快照名
  const linesRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const companies = useQuery({
    queryKey: ['purOutsourcedReceipts', 'companies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { results { id name } } }`,
      ).then((d) => d.basCompanies.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const resetItems = useCallback(() => setItems((cur) => (cur.length === 0 ? cur : [])), [])

  const openDrawer = useCallback<OpenReceiptDrawer>((mode, receipt) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row: receipt })
    orderItemsRef.current = new Map()
    linesRef.current = new Map()
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setMaterialRows([])
      setMaterialRowsSnapshot([])
      setByproductRows([])
      setByproductRowsSnapshot([])
      setDetailLoaded(true)
      return
    }
    const receiptId = receipt?.id
    // 防前端把 String(undefined) 当成 uuid 过滤(Invalid filter value "undefined")
    if (receiptId == null || receiptId === '' || receiptId === 'undefined') {
      toast.danger('无法打开入库单', { description: '缺少入库单 id' })
      setItems([])
      setItemsSnapshot([])
      setMaterialRows([])
      setMaterialRowsSnapshot([])
      setByproductRows([])
      setByproductRowsSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{
      purOutsourcedReceiptItems: { results: Row[] }
      purOutsourcedReceiptItemMaterials: { results: Row[] }
      purOutsourcedReceiptItemByproducts: { results: Row[] }
    }>(FETCH_DETAIL, { receiptId })
      .then((d) => {
        if (my !== reqIdRef.current) return
        const rows = d.purOutsourcedReceiptItems.results
        // 编辑态预热缓存:存量行不必再点选订单条目也能过校验/回填
        for (const r of rows) {
          if (r.orderItemId != null) {
            orderItemsRef.current.set(String(r.orderItemId), {
              id: String(r.orderItemId),
              materialId: r.materialId,
              unitId: r.unitId,
              materialCode: r.materialCode,
              materialName: r.materialName,
              materialSpec: r.materialSpec,
              customerPartNo: r.customerPartNo,
              unitName: r.unitName,
              qty: r.orderQty,
              order: r.orderNo != null ? { id: '', orderNo: r.orderNo } : undefined,
            } as Row)
          }
        }
        const materialRowList = d.purOutsourcedReceiptItemMaterials.results
        const byproductRowList = d.purOutsourcedReceiptItemByproducts.results
        // 扣减/副产物行的清单行缓存预热(材料/单位快照名回显用)
        for (const r of [...materialRowList, ...byproductRowList]) {
          const lineId = r.orderItemMaterialId ?? r.orderItemByproductId
          if (lineId != null) {
            linesRef.current.set(String(lineId), {
              id: String(lineId),
              materialCode: r.materialCode,
              materialName: r.materialName,
              materialSpec: r.materialSpec,
              unitName: r.unitName,
              orderNo: r.orderNo,
            } as Row)
          }
        }
        setItems(rows)
        setItemsSnapshot(rows)
        setMaterialRows(materialRowList)
        setMaterialRowsSnapshot(materialRowList)
        setByproductRows(byproductRowList)
        setByproductRowsSnapshot(byproductRowList)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('入库条目加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
        setMaterialRows([])
        setMaterialRowsSnapshot([])
        setByproductRows([])
        setByproductRowsSnapshot([])
      })
  }, [])

  const baseCfg = drawerConfig('purOutsourcedReceipts')
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      companyId: {
        ...baseCfg.fields?.companyId,
        defaultValue: createDefaultCompany,
        effects: () => ({
          warehouseId: null,
          outsourcedWarehouseId: null,
          debitAccountId: null,
          creditAccountId: null,
        }),
      },
      receiptDate: { ...baseCfg.fields?.receiptDate, defaultValue: todayLocal() },
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
            label="默认入仓(可空,成品行/副产物行预填)"
          />
        ),
      },
      outsourcedWarehouseId: {
        ...baseCfg.fields?.outsourcedWarehouseId,
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
          <OutsourcedWarehouseSelect
            value={value}
            onChange={onChange}
            isDisabled={isDisabled}
            partyType={(values.partyType as string | null) ?? null}
            partyId={(values.partyId as string | null) ?? null}
            label="默认外协仓(可空,材料扣减行预填)"
          />
        ),
      },
    },
  }

  return (
    <ReceiptDrawerContext.Provider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="purOutsourcedReceipts"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          setMaterialRows([])
          setMaterialRowsSnapshot([])
          setByproductRows([])
          setByproductRowsSnapshot([])
          orderItemsRef.current = new Map()
          linesRef.current = new Map()
        }}
        rowId={drawer?.row?.id}
        onEdit={
          drawer?.row?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          const companyId = (values.companyId as string | null) ?? null
          const partyType = (values.partyType as string | null) ?? null
          const partyId = (values.partyId as string | null) ?? null
          const headWarehouse = values.warehouseId
          const headOutsourcedWarehouse = values.outsourcedWarehouseId
          const headerReady = Boolean(companyId && partyType && partyId)
          const oiGridFilter = orderItemGridFilter(values)
          const tablesReadOnly =
            mode === 'view' ||
            (row != null && row.status !== 'DRAFT') ||
            (mode !== 'create' && !detailLoaded)
          // 已持久化的入库条目(扣减/副产物行只能挂服务端已存在的条目)
          const persistedItems = items.filter((r) => !isLocalRow(r))
          const itemById = new Map(persistedItems.map((r) => [String(r.id), r]))
          const itemLabel = (id: unknown) => {
            const it = id != null ? itemById.get(String(id)) : undefined
            if (!it) return id != null ? String(id).slice(0, 8) : '—'
            return [it.orderNo, it.materialName].filter(Boolean).map(String).join(' ')
          }

          // 条目录入:弹窗选委外订单条目后锁定回填物料/单位快照;用户只填数量/仓/备注
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            orderItemId: {
              order: 0,
              required: true,
              label: '委外订单条目',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="purOrderItems"
                  client={purchaseOrderItemClient}
                  label="委外订单条目"
                  dialogTitle="选择可入库委外订单条目"
                  placeholder={oiGridFilter ? '点击选择委外订单条目…' : '先选齐公司与对手'}
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
                    'receivedQty',
                    'remainingBaseQty',
                    'orderDate',
                    'orderNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, oitem) => {
                    void (async () => {
                      // 弹窗表格行可能缺 materialId(extraFields 未进缓存等):确认后按 id 补全
                      let row = oitem
                      if (id && (row?.materialId == null || row?.unitId == null)) {
                        try {
                          row = (await purchaseOrderItemClient.get(id)) ?? row
                        } catch {
                          /* 回填失败时仍写入 id,提交靠 transformItem/后端兜底 */
                        }
                      }
                      if (id && row) orderItemsRef.current.set(String(id), row)
                      onChange(id)
                      // 物料/单位随订单条目锁定带出;collectValues 会丢 hidden 字段,
                      // 真正落行靠 transformItem 读 orderItemsRef
                      patchItem({
                        materialId: row?.materialId ?? null,
                        unitId: row?.unitId ?? null,
                        materialCode: row?.materialCode ?? null,
                        materialName: row?.materialName ?? null,
                        materialSpec: row?.materialSpec ?? null,
                        customerPartNo: row?.customerPartNo ?? null,
                        unitName: row?.unitName ?? null,
                        orderNo: row?.orderNo ?? null,
                        orderQty: row?.qty ?? null,
                      })
                    })()
                  }}
                  isDisabled={isDisabled || oiGridFilter == null}
                  isRequired
                  gridFilter={oiGridFilter ?? undefined}
                  gridColumns={[
                    'orderDate',
                    'orderId',
                    'materialCode',
                    'materialName',
                    'materialSpec',
                    'customerPartNo',
                    'unitName',
                    'remainingBaseQty',
                  ]}
                  gridOverrides={{
                    orderDate: { label: '订单日期' },
                    orderId: {
                      label: '订单号',
                      render: (_v, r) => {
                        const order = r.order as Row | null | undefined
                        return order?.orderNo != null ? String(order.orderNo) : undefined
                      },
                    },
                    materialCode: { label: '物料编号' },
                    materialName: { label: '物料名称' },
                    materialSpec: { label: '规格' },
                    customerPartNo: { label: '客户料号' },
                    unitName: { label: '单位' },
                    remainingBaseQty: { label: '未入库数量' },
                  }}
                  gridDefaultSort={{ column: 'orderDate', direction: 'descending' }}
                  gridExtraFields={['materialId', 'unitId']}
                  dialogClassName="max-w-5xl"
                  renderValue={(r) => orderItemDisplay(r)}
                />
              ),
            },
            // 物料信息只读回显(不进提交手改路径;值由订单条目 patch 写入)
            materialName: {
              order: 1,
              label: '物料',
              input: ({ values: iv }) => {
                const code = iv.materialCode != null ? String(iv.materialCode) : ''
                const name = iv.materialName != null ? String(iv.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '选委外订单条目后自动带出'
                return <LockedText label="物料" value={text} />
              },
            },
            materialSpec: {
              order: 2,
              cols: 6,
              label: '规格',
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
              input: ({ values: iv }) => (
                <LockedText
                  label="单位"
                  value={iv.unitName != null ? String(iv.unitName) : '选委外订单条目后自动带出'}
                />
              ),
            },
            qty: { order: 5, cols: 6, required: true, label: '入库数量' },
            warehouseId: {
              order: 6,
              required: true,
              label: '入库仓库',
              // 新建行默认带出头上「默认入仓」(用户仍可改)
              defaultValue:
                headWarehouse == null || headWarehouse === '' ? null : String(headWarehouse),
              input: ({ value, onChange, isDisabled }) => (
                <WarehouseRemoteSelect
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  companyId={companyId}
                  label="入库仓库"
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
            // 手改物料/单位入口彻底隐藏(值仍随订单条目写入草稿行)
            materialId: { visible: () => false },
            unitId: { visible: () => false },
            materialCode: { visible: () => false },
          }

          /**
           * 扣减/副产物行表单的公共字段生成:
           * - receiptItemId 选已持久化入库条目(createOnly)
           * - 清单行 picker 按所选条目的订单条目过滤,材料/单位锁定带出
           */
          const rowFields = (kind: 'material' | 'byproduct'): Record<string, FieldOverride> => {
            const isMaterial = kind === 'material'
            const lineField = isMaterial ? 'orderItemMaterialId' : 'orderItemByproductId'
            const lineResource = isMaterial ? 'purOrderItemMaterials' : 'purOrderItemByproducts'
            const lineLabel = isMaterial ? '发料清单行' : '副产物清单行'
            return {
              idx: { visible: () => false },
              receiptItemId: {
                order: 0,
                required: true,
                label: '所属入库条目',
                edit: 'createOnly',
                effects: () => ({ [lineField]: null }),
                input: ({ value, onChange, isDisabled }) => (
                  <Select
                    isDisabled={isDisabled || persistedItems.length === 0}
                    value={value == null || value === '' ? null : String(value)}
                    onChange={(v) => onChange(v === '' ? null : v)}
                  >
                    <Label>所属入库条目</Label>
                    <Select.Trigger>
                      <Select.Value>
                        {({ isPlaceholder, defaultChildren }) =>
                          isPlaceholder ? (
                            <span className="text-muted">
                              {persistedItems.length === 0 ? '先保存入库条目' : '选择入库条目…'}
                            </span>
                          ) : (
                            defaultChildren
                          )
                        }
                      </Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {persistedItems.map((it) => (
                          <ListBox.Item
                            key={String(it.id)}
                            id={String(it.id)}
                            textValue={itemLabel(it.id)}
                          >
                            {itemLabel(it.id)}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                ),
              },
              [lineField]: {
                order: 1,
                required: true,
                label: lineLabel,
                edit: 'createOnly',
                input: ({ value, onChange, isDisabled, values: rv, patchValues: patchRow }) => {
                  const parentItem =
                    rv.receiptItemId != null ? itemById.get(String(rv.receiptItemId)) : undefined
                  const lineFilter =
                    parentItem?.orderItemId != null
                      ? { orderItemId: { eq: String(parentItem.orderItemId) } }
                      : undefined
                  return (
                    <RemoteDialogSelect
                      resource={lineResource}
                      label={lineLabel}
                      dialogTitle={`选择${lineLabel}`}
                      placeholder={lineFilter ? `点击选择${lineLabel}…` : '先选所属入库条目'}
                      labelField="materialId"
                      fields={['materialId', 'unitId', 'quantity']}
                      value={value == null ? null : String(value)}
                      onChange={(id, line) => {
                        void (async () => {
                          // 弹窗表格行缺材料快照名:确认后按 id 补全(材料/单位锁定展示用)
                          let row = line
                          if (id) {
                            try {
                              const data = await gqlFetch<Record<string, { results: Row[] }>>(
                                `query ($id: ID!) {
                                  ${lineResource}(filter: {id: {eq: $id}}, limit: 1, offset: 0) {
                                    results { id quantity material { id code name spec } unit { id name } }
                                  }
                                }`,
                                { id },
                              )
                              const full = data[lineResource].results[0]
                              if (full) {
                                const material = full.material as Row | null | undefined
                                const unit = full.unit as Row | null | undefined
                                row = {
                                  ...full,
                                  materialId: material?.id,
                                  unitId: unit?.id,
                                  materialCode: material?.code,
                                  materialName: material?.name,
                                  materialSpec: material?.spec,
                                  unitName: unit?.name,
                                } as Row
                              }
                            } catch {
                              /* 回填失败时仍写入 id,提交靠后端强制带出兜底 */
                            }
                            if (row) linesRef.current.set(String(id), row)
                          }
                          onChange(id)
                          patchRow({
                            materialCode: row?.materialCode ?? null,
                            materialName: row?.materialName ?? null,
                            materialSpec: row?.materialSpec ?? null,
                            unitName: row?.unitName ?? null,
                          })
                        })()
                      }}
                      isDisabled={isDisabled || lineFilter == null}
                      isRequired
                      gridFilter={lineFilter}
                      gridColumns={['materialId', 'unitId', 'quantity']}
                      gridOverrides={{
                        materialId: { label: isMaterial ? '材料' : '物料' },
                        unitId: { label: '单位' },
                        quantity: { label: '清单数量' },
                      }}
                      dialogClassName="max-w-3xl"
                      renderValue={(r) => {
                        const cached = r.id != null ? linesRef.current.get(String(r.id)) : undefined
                        const name = cached?.materialName ?? r.materialName
                        return name != null ? String(name) : lineLabel
                      }}
                    />
                  )
                },
              },
              materialName: {
                order: 2,
                label: isMaterial ? '材料' : '物料',
                input: ({ values: iv }) => {
                  const code = iv.materialCode != null ? String(iv.materialCode) : ''
                  const name = iv.materialName != null ? String(iv.materialName) : ''
                  const text = [code, name].filter(Boolean).join(' ') || `选${lineLabel}后自动带出`
                  return <LockedText label={isMaterial ? '材料' : '物料'} value={text} />
                },
              },
              unitName: {
                order: 3,
                cols: 6,
                label: '单位',
                input: ({ values: iv }) => (
                  <LockedText
                    label="单位"
                    value={iv.unitName != null ? String(iv.unitName) : `选${lineLabel}后自动带出`}
                  />
                ),
              },
              qty: { order: 4, cols: 6, required: true, label: isMaterial ? '扣减数量' : '入库数量' },
              ...(isMaterial
                ? {
                    outsourcedWarehouseId: {
                      order: 5,
                      label: '外协仓(审核前必填)',
                      defaultValue:
                        headOutsourcedWarehouse == null || headOutsourcedWarehouse === ''
                          ? null
                          : String(headOutsourcedWarehouse),
                      input: ({ value, onChange, isDisabled }: { value: unknown; onChange: (v: unknown) => void; isDisabled: boolean }) => (
                        <OutsourcedWarehouseSelect
                          value={value}
                          onChange={onChange}
                          isDisabled={isDisabled}
                          partyType={partyType}
                          partyId={partyId}
                          label="外协仓(审核前必填)"
                        />
                      ),
                    },
                  }
                : {
                    warehouseId: {
                      order: 5,
                      label: '入仓(审核前必填)',
                      defaultValue:
                        headWarehouse == null || headWarehouse === ''
                          ? null
                          : String(headWarehouse),
                      input: ({ value, onChange, isDisabled }: { value: unknown; onChange: (v: unknown) => void; isDisabled: boolean }) => (
                        <WarehouseRemoteSelect
                          value={value}
                          onChange={onChange}
                          isDisabled={isDisabled}
                          companyId={companyId}
                          label="入仓(审核前必填)"
                        />
                      ),
                    },
                  }),
              baseQty: {
                order: 6,
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
              remarks: { order: 7, label: '行备注' },
              // 材料/单位锁定以清单行为准,手改入口隐藏
              materialId: { visible: () => false },
              unitId: { visible: () => false },
              materialCode: { visible: () => false },
              materialSpec: { visible: () => false },
              orderNo: { visible: () => false },
            }
          }

          const materialRowFields = rowFields('material')
          const byproductRowFields = rowFields('byproduct')

          const rowColumns = (kind: 'material' | 'byproduct') =>
            [
              'idx',
              'receiptItemId',
              'materialName',
              'unitName',
              'qty',
              kind === 'material' ? 'outsourcedWarehouseId' : 'warehouseId',
              'baseQty',
              'remarks',
            ] as string[]

          const rowOverrides = (kind: 'material' | 'byproduct') => ({
            receiptItemId: {
              label: '入库条目',
              render: (v: unknown) => itemLabel(v),
            },
            materialName: {
              label: kind === 'material' ? '材料' : '物料',
              render: (_v: unknown, r: Row) => {
                const code = r.materialCode != null ? String(r.materialCode) : ''
                const name = r.materialName != null ? String(r.materialName) : ''
                const title = [code, name].filter(Boolean).join(' ')
                return title || undefined
              },
            },
            unitName: { label: '单位' },
            qty: { label: kind === 'material' ? '扣减数量' : '入库数量' },
            ...(kind === 'material'
              ? { outsourcedWarehouseId: { label: '外协仓' } }
              : { warehouseId: { label: '入仓' } }),
            baseQty: { label: '折算数量' },
            remarks: { label: '行备注' },
          })

          return (
            <>
              <CompanyDefaultSync
                mode={mode}
                values={values}
                patchValues={patchValues}
                defaultId={createDefaultCompany}
              />
              <ReceiptAccountDefaultSync
                key={`acct-${drawer?.row?.id ?? 'create'}-${reqIdRef.current}`}
                mode={mode}
                companyId={companyId}
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
                resource="purOutsourcedReceiptItems"
                label="入库条目"
                items={items}
                onChange={setItems}
                readOnly={tablesReadOnly}
                canCreate={headerReady}
                toolbar={
                  mode !== 'view' && !headerReady ? (
                    <span className="text-xs text-muted">先选齐公司、对手类型与对手</span>
                  ) : undefined
                }
                drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
                exclude={[
                  'receiptId',
                  'companyId',
                  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
                  'receiptNo',
                  'receiptDate',
                  'receiptStatus',
                  'partyType',
                  'partyId',
                  // 订单条目价税快照不进表单(物料/单位快照名走只读字段展示)
                  'orderQty',
                  'orderBaseQty',
                  'orderUnitName',
                  'orderPrice',
                  'orderAmount',
                  'orderBasePrice',
                  'orderBaseAmount',
                  'orderTaxRate',
                  'orderCurrencyCode',
                  'orderNo',
                  'reconciledQty',
                  // materialId/unitId 仍在 fields 里 visible:false 以保留提交值
                ]}
                columns={[
                  'idx',
                  'orderItemId',
                  'materialName',
                  'unitName',
                  'qty',
                  'warehouseId',
                  'baseQty',
                  'remarks',
                ]}
                overrides={{
                  orderItemId: {
                    // 物料另有列,此处只展示订单号
                    label: '订单',
                    render: (_v, r) =>
                      r.orderNo != null && r.orderNo !== '' ? String(r.orderNo) : undefined,
                  },
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
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, _items, editing) => {
                  if (!vals.orderItemId) return '请选择委外订单条目'
                  // materialId 是表单 hidden 字段,collectValues 会剥离——用缓存/编辑行判定
                  const cached =
                    vals.orderItemId != null
                      ? orderItemsRef.current.get(String(vals.orderItemId))
                      : undefined
                  const materialId = cached?.materialId ?? editing?.materialId ?? vals.materialId
                  const unitId = cached?.unitId ?? editing?.unitId ?? vals.unitId
                  if (!materialId || !unitId) return '请重新选择委外订单条目以带出物料'
                  if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                  if (!vals.warehouseId) return '请选择入库仓库'
                }}
                transformItem={(vals, editing) => {
                  const oitem =
                    vals.orderItemId != null
                      ? orderItemsRef.current.get(String(vals.orderItemId))
                      : undefined
                  const order = oitem?.order as Row | null | undefined
                  // hidden 字段不会进 collectValues:物料/单位必须以缓存或编辑行补全
                  const materialId = oitem?.materialId ?? editing?.materialId ?? vals.materialId
                  const unitId = oitem?.unitId ?? editing?.unitId ?? vals.unitId
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    // 新建行预填头默认入仓
                    ...(!editing && !vals.warehouseId && headWarehouse
                      ? { warehouseId: headWarehouse }
                      : {}),
                    materialId,
                    unitId,
                    materialCode:
                      oitem?.materialCode ?? editing?.materialCode ?? vals.materialCode ?? null,
                    materialName:
                      oitem?.materialName ?? editing?.materialName ?? vals.materialName ?? null,
                    materialSpec:
                      oitem?.materialSpec ?? editing?.materialSpec ?? vals.materialSpec ?? null,
                    customerPartNo:
                      oitem?.customerPartNo ??
                      editing?.customerPartNo ??
                      vals.customerPartNo ??
                      null,
                    unitName: oitem?.unitName ?? editing?.unitName ?? vals.unitName ?? null,
                    orderNo: order?.orderNo ?? editing?.orderNo ?? vals.orderNo ?? null,
                    orderQty: oitem?.qty ?? editing?.orderQty ?? vals.orderQty ?? null,
                  }
                }}
              />
              <p className="mt-6 text-xs text-muted">
                材料扣减行与副产物行在入库条目保存后按清单快照 ×(入库量÷订购量)自动带出;改入库数量不自动重算,可在此手改。
              </p>
              <SynieEditableTable
                resource="purOutsourcedReceiptItemMaterials"
                label="材料扣减行"
                items={materialRows}
                onChange={setMaterialRows}
                readOnly={tablesReadOnly}
                canCreate={persistedItems.length > 0}
                toolbar={
                  mode !== 'view' && persistedItems.length === 0 ? (
                    <span className="text-xs text-muted">保存入库条目后按比例带出,也可手工增行</span>
                  ) : undefined
                }
                drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
                exclude={['companyId', 'receiptNo', 'orderNo']}
                columns={rowColumns('material')}
                overrides={rowOverrides('material')}
                fields={materialRowFields}
                validateItem={(vals, _rows, editing) => {
                  if (!vals.receiptItemId) return '请选择所属入库条目'
                  if (!vals.orderItemMaterialId) return '请选择发料清单行'
                  const cached =
                    vals.orderItemMaterialId != null
                      ? linesRef.current.get(String(vals.orderItemMaterialId))
                      : undefined
                  const hasMaterial =
                    cached?.materialName ?? editing?.materialName ?? vals.materialName
                  if (!hasMaterial) return '请重新选择发料清单行以带出材料'
                  if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                }}
                transformItem={(vals, editing) => {
                  const line =
                    vals.orderItemMaterialId != null
                      ? linesRef.current.get(String(vals.orderItemMaterialId))
                      : undefined
                  const siblings = materialRows.filter(
                    (r) => String(r.receiptItemId) === String(vals.receiptItemId),
                  )
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : siblings.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    materialCode:
                      line?.materialCode ?? editing?.materialCode ?? vals.materialCode ?? null,
                    materialName:
                      line?.materialName ?? editing?.materialName ?? vals.materialName ?? null,
                    materialSpec:
                      line?.materialSpec ?? editing?.materialSpec ?? vals.materialSpec ?? null,
                    unitName: line?.unitName ?? editing?.unitName ?? vals.unitName ?? null,
                    orderNo: line?.orderNo ?? editing?.orderNo ?? vals.orderNo ?? null,
                  }
                }}
              />
              <SynieEditableTable
                resource="purOutsourcedReceiptItemByproducts"
                label="副产物行"
                items={byproductRows}
                onChange={setByproductRows}
                readOnly={tablesReadOnly}
                canCreate={persistedItems.length > 0}
                drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
                exclude={['companyId', 'receiptNo', 'orderNo']}
                columns={rowColumns('byproduct')}
                overrides={rowOverrides('byproduct')}
                fields={byproductRowFields}
                validateItem={(vals, _rows, editing) => {
                  if (!vals.receiptItemId) return '请选择所属入库条目'
                  if (!vals.orderItemByproductId) return '请选择副产物清单行'
                  const cached =
                    vals.orderItemByproductId != null
                      ? linesRef.current.get(String(vals.orderItemByproductId))
                      : undefined
                  const hasMaterial =
                    cached?.materialName ?? editing?.materialName ?? vals.materialName
                  if (!hasMaterial) return '请重新选择副产物清单行以带出物料'
                  if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                }}
                transformItem={(vals, editing) => {
                  const line =
                    vals.orderItemByproductId != null
                      ? linesRef.current.get(String(vals.orderItemByproductId))
                      : undefined
                  const siblings = byproductRows.filter(
                    (r) => String(r.receiptItemId) === String(vals.receiptItemId),
                  )
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : siblings.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    materialCode:
                      line?.materialCode ?? editing?.materialCode ?? vals.materialCode ?? null,
                    materialName:
                      line?.materialName ?? editing?.materialName ?? vals.materialName ?? null,
                    materialSpec:
                      line?.materialSpec ?? editing?.materialSpec ?? vals.materialSpec ?? null,
                    unitName: line?.unitName ?? editing?.unitName ?? vals.unitName ?? null,
                    orderNo: line?.orderNo ?? editing?.orderNo ?? vals.orderNo ?? null,
                  }
                }}
              />
              <ReceiptAccountFooter
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
          const deletedItemIds = new Set(
            itemsSnapshot
              .filter((old) => !items.some((r) => !isLocalRow(r) && r.id === old.id))
              .map((old) => String(old.id)),
          )
          const persistSideRows = (receiptId: string) =>
            Promise.all([
              persistRows({
                current: materialRows,
                snapshot: materialRowsSnapshot,
                deletedItemIds,
                inputOf: materialRowInput,
                changed: materialRowChanged,
                createMutation: CREATE_MATERIAL_ROW,
                updateMutation: UPDATE_MATERIAL_ROW,
                destroyMutation: DESTROY_MATERIAL_ROW,
                createKey: 'createPurOutsourcedReceiptItemMaterial',
                updateKey: 'updatePurOutsourcedReceiptItemMaterial',
                destroyKey: 'destroyPurOutsourcedReceiptItemMaterial',
              }),
              persistRows({
                current: byproductRows,
                snapshot: byproductRowsSnapshot,
                deletedItemIds,
                inputOf: byproductRowInput,
                changed: byproductRowChanged,
                createMutation: CREATE_BYPRODUCT_ROW,
                updateMutation: UPDATE_BYPRODUCT_ROW,
                destroyMutation: DESTROY_BYPRODUCT_ROW,
                createKey: 'createPurOutsourcedReceiptItemByproduct',
                updateKey: 'updatePurOutsourcedReceiptItemByproduct',
                destroyKey: 'destroyPurOutsourcedReceiptItemByproduct',
              }),
            ]).then(([a, b]) => [...a, ...b])

          const persistItemRows = async (receiptId: string, current: Row[], snapshot: Row[]) => {
            const errors: string[] = []
            const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
              if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
            }
            const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))
            for (const old of snapshot) {
              if (currentIds.has(old.id)) continue
              const data = await gqlFetch<{ destroyPurOutsourcedReceiptItem: MutationResult }>(
                DESTROY_ITEM,
                { id: old.id },
              )
              collect(old.idx, data.destroyPurOutsourcedReceiptItem?.errors)
            }
            for (const row of current) {
              if (isLocalRow(row)) {
                const data = await gqlFetch<{ createPurOutsourcedReceiptItem: MutationResult }>(
                  CREATE_ITEM,
                  { input: { receiptId, ...itemInput(row) } },
                )
                collect(row.idx, data.createPurOutsourcedReceiptItem?.errors)
                continue
              }
              const old = snapshot.find((s) => s.id === row.id)
              if (old && itemChanged(old, row)) {
                const data = await gqlFetch<{ updatePurOutsourcedReceiptItem: MutationResult }>(
                  UPDATE_ITEM,
                  { id: row.id, input: itemInput(row) },
                )
                collect(row.idx, data.updatePurOutsourcedReceiptItem?.errors)
              }
            }
            return errors
          }

          if (mode === 'create') {
            const data = await gqlFetch<{ createPurOutsourcedReceipt: MutationResult }>(
              CREATE_RECEIPT,
              { input: values },
            )
            const res = data.createPurOutsourcedReceipt
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const receiptId = res!.result!.id
            const itemErrors = await persistItemRows(receiptId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('入库单已创建,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('委外入库单已创建')
            }
            savedId = receiptId
          } else {
            const data = await gqlFetch<{ updatePurOutsourcedReceipt: MutationResult }>(
              UPDATE_RECEIPT,
              {
                id: drawer!.row!.id,
                input: values,
              },
            )
            const res = data.updatePurOutsourcedReceipt
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItemRows(drawer!.row!.id, items, itemsSnapshot)
            const rowErrors = await persistSideRows(drawer!.row!.id)
            const allErrors = [...itemErrors, ...rowErrors]
            if (allErrors.length > 0) {
              toast.danger('入库单已更新,但部分行保存失败', {
                description: allErrors.join('; '),
              })
            } else {
              toast.success('委外入库单已更新')
            }
            savedId = drawer!.row!.id
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purOutsourcedReceipts'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purOutsourcedReceiptItems'] })
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'purOutsourcedReceiptItemMaterials'],
          })
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'purOutsourcedReceiptItemByproducts'],
          })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'purOutsourcedReceipts'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purOrderItems'] })
          return savedId
        }}
      />
    </ReceiptDrawerContext.Provider>
  )
}
