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
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from '../-stock-doc'

export interface ReceiptRef {
  id: string
  status?: unknown
}

export type OpenReceiptDrawer = (mode: DrawerMode, receipt: ReceiptRef | null) => void

// 「审核整单」确认弹窗配置:条目页行操作与入库单页「审核」动作共用(见 scm/-audit-doc)
export const receiptAuditConfig = {
  docLabel: '采购入库单',
  mutation: 'auditPurReceipt',
  itemsResource: 'purReceiptItems',
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
  mutation ($input: CreatePurReceiptInput!) {
    createPurReceipt(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_RECEIPT = `
  mutation ($id: ID!, $input: UpdatePurReceiptInput!) {
    updatePurReceipt(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 只取快照与 id 字段,不 join material/unit/warehouse——
// 嵌套加载会走对方资源权限,无 read 时 GraphQL 非空关系变 null 整查询失败。
const FETCH_ITEMS = `
  query ($receiptId: ID!) {
    purReceiptItems(
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
  }
`
const CREATE_ITEM = `
  mutation ($input: CreatePurReceiptItemInput!) {
    createPurReceiptItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdatePurReceiptItemInput!) {
    updatePurReceiptItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyPurReceiptItem(id: $id) { errors { message } }
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

const ITEM_COMPARE_KEYS = ['idx', 'orderItemId', 'materialId', 'unitId', 'qty', 'warehouseId', 'remarks'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

interface MutationResult {
  result?: { id: string } | null
  errors: { message: string }[] | null
}

async function persistItems(
  receiptId: string,
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
    const data = await gqlFetch<{ destroyPurReceiptItem: MutationResult }>(DESTROY_ITEM, {
      id: old.id,
    })
    collect(old.idx, data.destroyPurReceiptItem?.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createPurReceiptItem: MutationResult }>(CREATE_ITEM, {
        input: { receiptId, ...itemInput(row) },
      })
      collect(row.idx, data.createPurReceiptItem?.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updatePurReceiptItem: MutationResult }>(UPDATE_ITEM, {
        id: row.id,
        input: itemInput(row),
      })
      collect(row.idx, data.updatePurReceiptItem?.errors)
    }
  }
  return errors
}

/**
 * 科目候选 filter。枚举值必须是 GraphQL enum 裸 token(不可 JSON 字符串)。
 */
function accountFilter(companyId: string | null, roleEnum?: string): string | undefined {
  if (!companyId) return undefined
  const base = `companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}`
  if (roleEnum) return `{${base}, role: {eq: ${roleEnum}}}`
  return `{${base}}`
}

/**
 * 有效订单条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核订单 2. 公司/对手与入库头一致 3. 未收数量 > 0
 * 枚举值用 gqlEnum 包装(不可 JSON 字符串)。
 */
function orderItemGridFilter(values: Record<string, unknown>): Record<string, unknown> | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  return {
    and: [
      { orderStatus: { eq: gqlEnum('AUDITED') } },
      { companyId: { eq: String(companyId) } },
      { partyType: { eq: gqlEnum(String(partyType)) } },
      { partyId: { eq: String(partyId) } },
      { remainingBaseQty: { greaterThan: '0' } },
    ],
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
 * 头关键字段变更清行:公司/对手类型/对手任一变则清空条目草稿
 * (与销售发货 ItemsResetGuard 同构;edit 等行主数据回填后再布防)。
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
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [filters] = useState<FilterState>({})
  // 订单条目缓存:选择时写入完整行,transformItem 带出快照名
  const orderItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const companies = useQuery({
    queryKey: ['purReceipts', 'companies'],
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
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    const receiptId = receipt?.id
    // 防前端把 String(undefined) 当成 uuid 过滤(Invalid filter value "undefined")
    if (receiptId == null || receiptId === '' || receiptId === 'undefined') {
      toast.danger('无法打开入库单', { description: '缺少入库单 id' })
      setItems([])
      setItemsSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{ purReceiptItems: { results: Row[] } }>(FETCH_ITEMS, {
      receiptId,
    })
      .then((d) => {
        if (my !== reqIdRef.current) return
        const rows = d.purReceiptItems.results
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
        setItems(rows)
        setItemsSnapshot(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('入库条目加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
      })
  }, [])

  const baseCfg = drawerConfig('purReceipts')
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
        effects: () => ({ warehouseId: null, debitAccountId: null, creditAccountId: null }),
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
            label="默认仓库(可空,新建行预填)"
          />
        ),
      },
      debitAccountId: {
        ...baseCfg.fields?.debitAccountId,
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
        }) => {
          const companyId = (values.companyId as string | null) ?? null
          return (
            <RemoteSelect
              resource="basAccounts"
              label="借方科目"
              placeholder={companyId ? '选择借方科目(存货/费用等)…' : '先选择公司'}
              value={value == null || value === '' ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled || !companyId}
              filter={accountFilter(companyId)}
              labelField="name"
              searchFields={['name', 'code']}
              itemSubtitleFields={['code']}
            />
          )
        },
      },
      creditAccountId: {
        ...baseCfg.fields?.creditAccountId,
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
        }) => {
          const companyId = (values.companyId as string | null) ?? null
          return (
            <RemoteSelect
              resource="basAccounts"
              label="贷方科目(未开票应付)"
              placeholder={companyId ? '选择未开票应付科目…' : '先选择公司'}
              value={value == null || value === '' ? null : String(value)}
              onChange={(id) => onChange(id)}
              isDisabled={isDisabled || !companyId}
              filter={accountFilter(companyId, 'UNBILLED_PAYABLE')}
              labelField="name"
              searchFields={['name', 'code']}
              itemSubtitleFields={['code']}
            />
          )
        },
      },
    },
  }

  return (
    <ReceiptDrawerContext.Provider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="purReceipts"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          orderItemsRef.current = new Map()
        }}
        rowId={drawer?.row?.id}
        onEdit={
          drawer?.row?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          const companyId = (values.companyId as string | null) ?? null
          const headWarehouse = values.warehouseId
          const headerReady = Boolean(values.companyId && values.partyType && values.partyId)
          const oiGridFilter = orderItemGridFilter(values)

          // 条目录入:弹窗选订单条目后锁定回填物料/单位快照;用户只填数量/仓/备注
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            orderItemId: {
              order: 0,
              required: true,
              label: '订单条目',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="purOrderItems"
                  label="订单条目"
                  dialogTitle="选择可入库订单条目"
                  placeholder={oiGridFilter ? '点击选择订单条目…' : '先选齐公司与对手'}
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
                    'order { id orderNo }',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, oitem) => {
                    void (async () => {
                      // 弹窗表格行可能缺 materialId(extraFields 未进缓存等):确认后按 id 补全
                      let row = oitem
                      if (id && (row?.materialId == null || row?.unitId == null)) {
                        try {
                          const data = await gqlFetch<{
                            purOrderItems: { results: Row[] }
                          }>(
                            `query ($id: ID!) {
                              purOrderItems(filter: {id: {eq: $id}}, limit: 1, offset: 0) {
                                results {
                                  id materialId unitId materialCode materialName materialSpec
                                  customerPartNo unitName qty baseQty receivedQty remainingBaseQty
                                  order { id orderNo }
                                }
                              }
                            }`,
                            { id },
                          )
                          row = data.purOrderItems.results[0] ?? row
                        } catch {
                          /* 回填失败时仍写入 id,提交靠 transformItem/后端兜底 */
                        }
                      }
                      if (id && row) orderItemsRef.current.set(String(id), row)
                      onChange(id)
                      const order = row?.order as Row | null | undefined
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
                        orderNo: order?.orderNo ?? null,
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
                const text = [code, name].filter(Boolean).join(' ') || '选订单条目后自动带出'
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
                  value={iv.unitName != null ? String(iv.unitName) : '选订单条目后自动带出'}
                />
              ),
            },
            qty: { order: 5, cols: 6, required: true, label: '入库数量' },
            warehouseId: {
              order: 6,
              required: true,
              label: '入库仓库',
              // 新建行默认带出头上「默认仓库」(用户仍可改)
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

          return (
            <>
              <CompanyDefaultSync
                mode={mode}
                values={values}
                patchValues={patchValues}
                defaultId={createDefaultCompany}
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
                resource="purReceiptItems"
                label="入库条目"
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
                      if (!title && r.materialSpec == null && r.customerPartNo == null) return undefined
                      const spec = r.materialSpec != null && r.materialSpec !== '' ? String(r.materialSpec) : null
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
                  if (!vals.orderItemId) return '请选择订单条目'
                  // materialId 是表单 hidden 字段,collectValues 会剥离——用缓存/编辑行判定
                  const cached =
                    vals.orderItemId != null
                      ? orderItemsRef.current.get(String(vals.orderItemId))
                      : undefined
                  const materialId =
                    cached?.materialId ?? editing?.materialId ?? vals.materialId
                  const unitId = cached?.unitId ?? editing?.unitId ?? vals.unitId
                  if (!materialId || !unitId) return '请重新选择订单条目以带出物料'
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
                    // 新建行预填头默认仓
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
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const data = await gqlFetch<{ createPurReceipt: MutationResult }>(CREATE_RECEIPT, {
              input: values,
            })
            const res = data.createPurReceipt
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const receiptId = res!.result!.id
            const itemErrors = await persistItems(receiptId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('入库单已创建,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('采购入库单已创建')
            }
            savedId = receiptId
          } else {
            const data = await gqlFetch<{ updatePurReceipt: MutationResult }>(UPDATE_RECEIPT, {
              id: drawer!.row!.id,
              input: values,
            })
            const res = data.updatePurReceipt
            if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(drawer!.row!.id, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('入库单已更新,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('采购入库单已更新')
            }
            savedId = drawer!.row!.id
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purReceipts'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purReceiptItems'] })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'purReceipts'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purOrderItems'] })
          return savedId
        }}
      />
    </ReceiptDrawerContext.Provider>
  )
}
