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
import { companyClient } from '~/lib/resources/companies'
import {
  purchaseReceiptItemClient,
} from '~/lib/resources/fulfillment'
import { buildPurchaseReceiptDraft } from '~/lib/resources/purchase-receipt-draft'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import { purchaseOrderItemClient } from '~/lib/resources/orders'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { auditMaterialCell, type AuditDocConfig } from '../-audit-doc'
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from '../-stock-doc'
import { fetchCompanyAccountDefaults } from '../settings/-company-account-defaults'

const purchaseReceiptBinding = resourceBindingFor('purReceipts')
const purchaseReceiptItemBinding = resourceBindingFor('purReceiptItems')
const purchaseOrderItemBinding = resourceBindingFor('purOrderItems')
const purchaseReceiptDraft = aggregateDraftFor('purReceipts')

export interface ReceiptRef {
  id: string
  status?: unknown
}

export type OpenReceiptDrawer = (mode: DrawerMode, receipt: ReceiptRef | null) => void

// 「审核整单」确认弹窗配置:条目页行操作与入库单页「审核」动作共用(见 scm/-audit-doc)
export const receiptAuditConfig = {
  docLabel: '采购入库单',
  resource: 'purReceipts',
  commandKey: 'audit',
  itemsResource: 'purReceiptItems',
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ drawingOwnerType: 'pur_receipt_item' }),
    },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '入库数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
  loadItems: (receiptId: string) =>
    purchaseReceiptItemClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: {
          receiptId: { kind: 'fk', op: 'in', values: [receiptId], labels: [] },
        },
      })
      .then((result) => result.results),
} satisfies AuditDocConfig

const ReceiptDrawerContext = createContext<OpenReceiptDrawer>(() => {})

export function useReceiptDrawer(): OpenReceiptDrawer {
  return useContext(ReceiptDrawerContext)
}

function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 科目候选的 REST 结构化筛选。 */
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
  const debit = values.debitAccountId == null || values.debitAccountId === '' ? null : String(values.debitAccountId)
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
        filterState={accountFilter(companyId)}
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
        filterState={accountFilter(companyId, 'UNBILLED_PAYABLE')}
        labelField="name"
        searchFields={['name', 'code']}
        itemSubtitleFields={['code']}
      />
    </div>
  )
}

/**
 * 有效订单条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核订单 2. 公司/对手与入库头一致 3. 未收数量 > 0
 * 使用 REST FilterState，权限与公司/对手/剩余数量条件由服务端白名单解释。
 */
function orderItemGridFilter(values: Record<string, unknown>): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  return {
    orderStatus: { kind: 'enum', values: ['AUDITED'] },
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
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [filters] = useState<FilterState>({})
  // 订单条目缓存:选择时写入完整行,transformItem 带出快照名
  const orderItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)
  const draftHeadRef = useRef<Row | null>(null)

  const companies = useQuery({
    queryKey: ['purReceipts', 'companies'],
    queryFn: () =>
      companyClient
        .query({
          limit: 50,
          offset: 0,
          sort: { column: 'code', direction: 'ascending' },
        })
        .then((result) => result.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const resetItems = useCallback(() => setItems((cur) => (cur.length === 0 ? cur : [])), [])

  const openDrawer = useCallback<OpenReceiptDrawer>((mode, receipt) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row: receipt })
    orderItemsRef.current = new Map()
    draftHeadRef.current = null
    if (mode === 'create') {
      setItems([])
      setDetailLoaded(true)
      return
    }
    const receiptId = receipt?.id
    // 防前端把 String(undefined) 当成 uuid 过滤(Invalid filter value "undefined")
    if (receiptId == null || receiptId === '' || receiptId === 'undefined') {
      toast.danger('无法打开入库单', { description: '缺少入库单 id' })
      setItems([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    purchaseReceiptDraft
      .loadDraft(receiptId)
      .then((draft) => {
        if (my !== reqIdRef.current) return
        draftHeadRef.current = draft
        const rows = draft.items
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
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        draftHeadRef.current = null
        toast.danger('入库条目加载失败', { description: (e as Error).message })
        setItems([])
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
        isSubmitDisabled={drawer?.mode === 'edit' && !detailLoaded}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          orderItemsRef.current = new Map()
          draftHeadRef.current = null
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
                  'materialCode',
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
                  // 物料列:全站统一富单元格(图纸缩略图+快照四字段,行图纸挂接 pur_receipt_item);
                  // 快照随订单条目锁定回填(transformItem),新行也有完整快照
                  materialCode: {
                    label: '物料',
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: materialCellRender({ drawingOwnerType: 'pur_receipt_item' }),
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
              <ReceiptAccountFooter
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
          assertAggregateDraftReady(mode, detailLoaded, '采购入库明细')
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          const draft = buildPurchaseReceiptDraft(
            { ...draftHeadRef.current, ...values },
            items,
          )
          let saved: Row
          if (mode === 'create') {
            saved = await purchaseReceiptDraft.createDraft(draft)
            toast.success('采购入库单已创建')
          } else {
            saved = await purchaseReceiptDraft.replaceDraft(
              drawer!.row!.id,
              draft,
            )
            toast.success('采购入库单已更新')
          }
          await Promise.all([
            purchaseReceiptBinding.cache.invalidateAll(queryClient),
            purchaseReceiptItemBinding.cache.invalidateGrid(queryClient),
            purchaseOrderItemBinding.cache.invalidateGrid(queryClient),
          ])
          return String(saved.id)
        }}
      />
    </ReceiptDrawerContext.Provider>
  )
}
