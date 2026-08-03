import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Label, ListBox, Modal, NumberField, Select, TextField, toast } from '@heroui/react'
import { companyClient } from '~/lib/resources/companies'
import { APIError } from '~/lib/api/client'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import type {
  SalesDeliveryDraftInput,
  SalesDeliveryDraftItemInput,
  SalesDeliveryDraftPackLineInput,
  SalesDeliverySavedDraft,
} from '~/lib/resources/fulfillment'
import { salesOrderItemClient } from '~/lib/resources/orders'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow, localRowId } from '~/components/synie-editable-table/editable'
import {
  generateItemsFromPack,
  parseMicros,
  parseScaled,
  qtyDivFactorToMicros,
  type FifoCandidate,
  type GenerateReport,
} from '~/lib/delivery-pack-generate'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { materialClient, materialUnitClient } from '~/lib/resources/inventory'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { auditMaterialCell, type AuditDocConfig } from '../../scm/-audit-doc'
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from '../../scm/-stock-doc'
import { fetchCompanyAccountDefaults } from '../../scm/settings/-company-account-defaults'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { todayLocal } from '~/lib/form-defaults'
import { toastError } from '~/lib/toast'
import { useDocumentDrawer } from '~/lib/use-document-drawer'

const salesDeliveryBinding = resourceBindingFor('salDeliveries')
const salesDeliveryDraft = aggregateDraftFor('salDeliveries')

export interface DeliveryRef {
  id: string
  status?: unknown
}

export type OpenDeliveryDrawer = (mode: DrawerMode, delivery: DeliveryRef | null) => void

/**
 * 审核确认弹窗：子记录经完整草稿读取（无分页截断），不走默认 limit 的子资源 query。
 */
async function loadDeliveryItemsForAudit(deliveryId: string): Promise<Row[]> {
  return (await salesDeliveryDraft.loadDraft(deliveryId)).items
}

// 「审核整单」确认弹窗配置:条目页行操作与发货单页「审核」动作共用(见 scm/-audit-doc)
export const deliveryAuditConfig = {
  docLabel: '销售发货单',
  resource: 'salDeliveries',
  commandKey: 'audit',
  itemsResource: 'salDeliveryItems',
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ drawingOwnerType: 'sal_delivery_item' }),
    },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '发货数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
  loadItems: loadDeliveryItemsForAudit,
} satisfies AuditDocConfig

const DeliveryDrawerContext = createContext<OpenDeliveryDrawer>(() => {})

export function useDeliveryDrawer(): OpenDeliveryDrawer {
  return useContext(DeliveryDrawerContext)
}

/** 提交 mutation:物料/单位由订单条目锁定带出,后端再快照与折算 */
function itemInput(row: Row): SalesDeliveryDraftItemInput {
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '发货条目序号'),
    orderItemId: requiredString(row.orderItemId, '订单条目'),
    unitId: nullableString(row.unitId),
    qty: requiredString(row.qty, '发货数量'),
    warehouseId: requiredString(row.warehouseId, '发货仓库'),
    remarks: nullableString(row.remarks),
  }
}

/** 提交 mutation:快照字段由后端保存时重拍；所属箱由嵌套层级表达。 */
function packLineInput(row: Row): SalesDeliveryDraftPackLineInput {
  return {
    ...(!isLocalRow(row) ? { id: String(row.id) } : {}),
    idx: requiredIndex(row.idx, '装箱条目序号'),
    materialId: requiredString(row.materialId, '装箱物料'),
    unitId: nullableString(row.unitId),
    qty: requiredString(row.qty, '装箱数量'),
    remarks: nullableString(row.remarks),
  }
}

function nullableString(value: unknown): string | null {
  return value == null || value === '' ? null : String(value)
}

function requiredString(value: unknown, label: string): string {
  const result = nullableString(value)
  if (result == null) throw new Error(`${label}不能为空`)
  return result
}

function requiredIndex(value: unknown, label: string): number {
  const result = Number(value)
  if (!Number.isInteger(result)) throw new Error(`${label}必须是整数`)
  return result
}

interface DeliveryDraftIndex {
  itemRowIds: string[]
  boxRowIds: string[]
  lineRowIds: string[][]
}

function buildDeliveryDraft(
  values: Record<string, unknown>,
  items: Row[],
  packBoxes: Row[],
  packLines: Row[],
): { draft: SalesDeliveryDraftInput; index: DeliveryDraftIndex } {
  const linesByBox = packBoxes.map((box) =>
    packLines.filter((line) => String(line.packBoxId) === String(box.id)),
  )
  return {
    draft: {
      companyId: requiredString(values.companyId, '公司'),
      deliveryNo: nullableString(values.deliveryNo),
      deliveryDate: nullableString(values.deliveryDate),
      postingDate: nullableString(values.postingDate),
      partyType: requiredString(values.partyType, '对手类型'),
      partyId: requiredString(values.partyId, '对手'),
      remarks: nullableString(values.remarks),
      warehouseId: nullableString(values.warehouseId),
      debitAccountId: requiredString(values.debitAccountId, '借方科目'),
      creditAccountId: requiredString(values.creditAccountId, '贷方科目'),
      items: items.map(itemInput),
      packBoxes: packBoxes.map((box, boxIndex) => ({
        ...(!isLocalRow(box) ? { id: String(box.id) } : {}),
        lines: linesByBox[boxIndex].map(packLineInput),
      })),
    },
    index: {
      itemRowIds: items.map((row) => String(row.id)),
      boxRowIds: packBoxes.map((row) => String(row.id)),
      lineRowIds: linesByBox.map((lines) => lines.map((row) => String(row.id))),
    },
  }
}

function normalizedErrorPath(path: string): string {
  return path.replace(/\.(\d+)(?=\.|$)/g, '[$1]')
}

function headerFieldErrors(fields: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [rawPath, messages] of Object.entries(fields)) {
    const path = normalizedErrorPath(rawPath)
    if (path.startsWith('items') || path.startsWith('packBoxes')) continue
    const field = path.startsWith('header.') ? path.slice('header.'.length) : path
    result[field] = [...(result[field] ?? []), ...messages]
  }
  return result
}

function rowErrors(
  fields: Record<string, string[]>,
  pattern: RegExp,
  resolve: (...indexes: number[]) => Row | undefined,
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [rawPath, messages] of Object.entries(fields)) {
    const matched = pattern.exec(normalizedErrorPath(rawPath))
    if (!matched) continue
    const indexes = matched.slice(1, -1).map(Number)
    const row = resolve(...indexes)
    if (!row) continue
    const field = matched.at(-1)
    const rendered = messages.map((message) => (field ? `${field}: ${message}` : message))
    result[String(row.id)] = [...(result[String(row.id)] ?? []), ...rendered]
  }
  return result
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
 * 新建态:公司选定/变更时整组覆盖借贷科目为该公司默认(无默认则清空)。
 * 编辑态公司锁死,不重灌。
 */
function DeliveryAccountDefaultSync({
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
        debitAccountId: row?.deliveryDebitAccountId ?? null,
        creditAccountId: row?.deliveryCreditAccountId ?? null,
      })
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, companyId])

  return null
}

function DeliveryAccountFooter({
  mode,
  values,
  patchValues,
  isDisabled,
  fieldErrors,
}: {
  mode: DrawerMode
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  isDisabled: boolean
  fieldErrors?: Record<string, string[]>
}) {
  const companyId = (values.companyId as string | null) ?? null
  const debit = values.debitAccountId == null || values.debitAccountId === '' ? null : String(values.debitAccountId)
  const credit =
    values.creditAccountId == null || values.creditAccountId === '' ? null : String(values.creditAccountId)

  return (
    <div className="mt-6 grid grid-cols-1 gap-4 border-t border-separator pt-4 lg:grid-cols-2">
      <div>
        <RemoteSelect
          resource="basAccounts"
          label="借方科目(未开票应收)"
          placeholder={companyId ? '选择未开票应收科目…' : '先选择公司'}
          value={debit}
          onChange={(id) => patchValues({ debitAccountId: id })}
          isDisabled={isDisabled || !companyId || mode === 'view'}
          isRequired={mode !== 'view'}
          filterState={accountFilter(companyId, 'UNBILLED_RECEIVABLE')}
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
          label="贷方科目"
          placeholder={companyId ? '选择贷方科目(收入/待转等)…' : '先选择公司'}
          value={credit}
          onChange={(id) => patchValues({ creditAccountId: id })}
          isDisabled={isDisabled || !companyId || mode === 'view'}
          isRequired={mode !== 'view'}
          filterState={accountFilter(companyId)}
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

/**
 * 有效订单条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核订单 2. 公司/对手与发货头一致 3. 未发数量 > 0
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

/**
 * 可发货订单条目池:装箱物料候选(票02)与「从装箱清单获取」(票03)共用一份查询缓存。
 * 池口径与订单条目选择弹窗完全一致(同公司同对手、订单已审核、未发数量>0);
 * REST 列表默认返回全字段(含 orderDate/orderNo/currencyCode/remainingBaseQty),无需 extraFields。
 */
function deliveryPackPoolQuery(values: Record<string, unknown>) {
  const filter = orderItemGridFilter(values)
  return {
    queryKey: ['deliveryPackPool', filter] as const,
    enabled: filter != null,
    queryFn: () =>
      salesOrderItemClient
        .query({
          // 服务端列表上限 200(超出 400);单一对手的可发货条目池实务上远小于此
          limit: 200,
          offset: 0,
          // FIFO 分摊按订单日期升序消费,池查询直接按此序返回
          sort: { column: 'orderDate', direction: 'ascending' as const },
          filter: filter!,
        })
        .then((result) => result.results),
  }
}

function orderItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining = r.remainingBaseQty != null ? String(r.remainingBaseQty) : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem = remaining != null ? `未发${remaining}${unit ? unit : ''}` : ''
  return [material || '订单条目', rem].filter(Boolean).join(' · ')
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
 * 装箱行折算数量:选齐物料/单位/数量后按「base = 数量 ÷ 换算系数」实时折算展示
 * (仅展示口径,落库仍由后端保存时重拍);未选齐或选项未载入时回显行上已存值。
 */
function LiveBaseQtyField({
  materialId,
  unitId,
  qty,
  value,
}: {
  materialId: string | null
  unitId: unknown
  qty: unknown
  value: unknown
}) {
  const query = useQuery({
    queryKey: ['packLineUnitFactors', materialId],
    enabled: materialId != null,
    staleTime: 60_000,
    queryFn: () =>
      Promise.all([
        materialClient.get(materialId!),
        materialUnitClient.query({
          limit: 200,
          offset: 0,
          filter: { materialId: { kind: 'fk', op: 'in', values: [materialId!], labels: [] } },
        }),
      ]).then(([material, conversions]) => ({
        defaultUnitId:
          material?.defaultUnitId != null ? String(material.defaultUnitId) : null,
        factors: new Map(
          conversions.results
            .filter((r) => r.unitId != null)
            .map((r) => [String(r.unitId), Number(r.factor)] as const),
        ),
      })),
  })

  const unit = unitId == null || unitId === '' ? null : String(unitId)
  const entered = Number(qty)
  let live: number | null = null
  if (materialId != null && unit != null && entered > 0 && query.data != null) {
    if (unit === query.data.defaultUnitId) {
      live = entered
    } else {
      const factor = query.data.factors.get(unit)
      if (factor != null && factor > 0) live = Math.round((entered / factor) * 1e6) / 1e6
    }
  }
  const shown = live ?? (value == null || value === '' ? NaN : Number(value))
  return (
    <NumberField fullWidth isDisabled value={shown}>
      <Label>折算数量(默认单位)</Label>
      <NumberField.Group className="grid-cols-[1fr]">
        <NumberField.Input placeholder="选齐物料/单位/数量自动折算" />
      </NumberField.Group>
    </NumberField>
  )
}

/**
 * 头关键字段变更清行(ItemsResetGuard)的指纹字段:公司/对手类型/对手任一变则清空条目草稿。
 */
const ITEMS_RESET_FIELDS = ['companyId', 'partyType', 'partyId'] as const

/**
 * 「从装箱清单获取」按钮(发货条目工具栏):按装箱汇总 FIFO 分摊生成缺失物料的发货草稿行。
 * 规则实现集中在纯函数 generateItemsFromPack(~/lib/delivery-pack-generate),
 * 本组件只负责取数(订单条目池/单位系数)、装配行与两档结果反馈。
 */
function GenerateFromPackButton({
  values,
  packLines,
  items,
  orderItemsRef,
  onGenerated,
}: {
  values: Record<string, unknown>
  packLines: Row[]
  items: Row[]
  orderItemsRef: React.RefObject<Map<string, Row>>
  onGenerated: (rows: Row[]) => void
}) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<GenerateReport | null>(null)

  const headWarehouse = values.warehouseId
  const noPackLines = packLines.length === 0

  const run = async () => {
    if (headWarehouse == null || headWarehouse === '') {
      toast.danger('请先填写默认仓库', {
        description: '「从装箱清单获取」生成的发货行以头默认仓库预填行仓',
      })
      return
    }
    setBusy(true)
    try {
      // 1. 可发货订单条目池(与装箱物料候选共用缓存键)
      const poolQuery = deliveryPackPoolQuery(values)
      const poolRows = poolQuery.enabled
        ? await queryClient.fetchQuery({
            queryKey: poolQuery.queryKey,
            queryFn: poolQuery.queryFn,
            staleTime: 30_000,
          })
        : []

      // 2. 单位系数表:本单全部相关物料的默认单位(=1)与转换单位
      const materialIds = new Set<string>()
      for (const r of [...packLines, ...items, ...poolRows]) {
        if (r.materialId != null && r.materialId !== '') materialIds.add(String(r.materialId))
      }
      const factorMap = new Map<string, { num: bigint; scale: number }>()
      await Promise.all(
        Array.from(materialIds).map(async (mid) => {
          const [material, conversions] = await Promise.all([
            materialClient.get(mid),
            materialUnitClient.query({
              limit: 200,
              offset: 0,
              filter: { materialId: { kind: 'fk', op: 'in', values: [mid], labels: [] } },
            }),
          ])
          if (material?.defaultUnitId != null) {
            factorMap.set(`${mid}:${String(material.defaultUnitId)}`, { num: 1n, scale: 0 })
          }
          for (const c of conversions.results) {
            if (c.unitId != null) {
              factorMap.set(`${mid}:${String(c.unitId)}`, parseScaled(String(c.factor ?? '0')))
            }
          }
        }),
      )

      // 行 base 推算:已存 baseQty 优先,否则 qty ÷ factor 现场折算(与服务端同口径 HALF_UP)
      const baseMicrosOf = (r: Row): bigint => {
        if (r.baseQty != null && r.baseQty !== '') return parseMicros(r.baseQty)
        const factor = factorMap.get(`${String(r.materialId ?? '')}:${String(r.unitId ?? '')}`)
        if (!factor) return 0n
        return qtyDivFactorToMicros(parseScaled(String(r.qty ?? '0')), factor)
      }
      const labelOf = (r: Row): string =>
        [r.materialCode, r.materialName].filter((x) => x != null && x !== '').join(' ') || '未名物料'

      // 3. 装箱汇总(按物料)
      const packMap = new Map<string, { label: string; micros: bigint }>()
      for (const r of packLines) {
        if (r.materialId == null || r.materialId === '') continue
        const key = String(r.materialId)
        const cur = packMap.get(key) ?? { label: labelOf(r), micros: 0n }
        cur.micros += baseMicrosOf(r)
        packMap.set(key, cur)
      }

      // 4. 既有条目:base 汇总 + 订单币种(池内直取,池外按 id 补查)
      const poolById = new Map(poolRows.map((r) => [String(r.id), r]))
      const missingCurrencyIds = Array.from(
        new Set(
          items
            .map((r) => (r.orderItemId != null ? String(r.orderItemId) : null))
            .filter((id): id is string => id != null && !poolById.has(id)),
        ),
      )
      const fetchedCurrency = new Map<string, string>()
      await Promise.all(
        missingCurrencyIds.map(async (id) => {
          const row = await salesOrderItemClient.get(id).catch(() => null)
          fetchedCurrency.set(id, row?.currencyCode != null ? String(row.currencyCode) : '')
        }),
      )
      const currencyOf = (orderItemId: unknown): string => {
        if (orderItemId == null) return ''
        const id = String(orderItemId)
        const pooled = poolById.get(id)
        if (pooled?.currencyCode != null) return String(pooled.currencyCode)
        return fetchedCurrency.get(id) ?? ''
      }

      // 5. 装配纯函数输入并执行
      const result = generateItemsFromPack({
        packs: Array.from(packMap, ([materialId, v]) => ({
          materialId,
          label: v.label,
          packedMicros: v.micros,
        })),
        candidates: poolRows
          .filter((r) => r.materialId != null && r.unitId != null)
          .map((r): FifoCandidate => {
            const factor = factorMap.get(`${String(r.materialId)}:${String(r.unitId)}`) ?? {
              num: 1n,
              scale: 0,
            }
            return {
              orderItemId: String(r.id),
              orderDate: r.orderDate != null ? String(r.orderDate) : '',
              orderNo: r.orderNo != null ? String(r.orderNo) : '',
              materialId: String(r.materialId),
              unitId: String(r.unitId),
              unitName: r.unitName != null ? String(r.unitName) : '',
              currencyCode: r.currencyCode != null ? String(r.currencyCode) : '',
              remainingMicros: parseMicros(r.remainingBaseQty),
              factorNum: factor.num,
              factorScale: factor.scale,
              orderQty: r.qty != null ? String(r.qty) : null,
              materialCode: r.materialCode != null ? String(r.materialCode) : null,
              materialName: r.materialName != null ? String(r.materialName) : null,
              materialSpec: r.materialSpec != null ? String(r.materialSpec) : null,
              customerPartNo: r.customerPartNo != null ? String(r.customerPartNo) : null,
            }
          }),
        existing: items
          .filter((r) => r.materialId != null && r.materialId !== '')
          .map((r) => ({
            materialId: String(r.materialId),
            label: labelOf(r),
            baseMicros: baseMicrosOf(r),
            currencyCode: currencyOf(r.orderItemId),
          })),
      })

      // 6. 生成行落本地草稿:缓存订单条目(validateItem/transformItem 链路),预填头默认仓
      for (const l of result.lines) {
        const poolRow = poolById.get(l.orderItemId)
        if (poolRow) orderItemsRef.current?.set(l.orderItemId, poolRow)
      }
      let maxIdx = items.reduce((m, r) => Math.max(m, Number(r.idx) || 0), 0)
      const newRows = result.lines.map(
        (l): Row => ({
          id: localRowId(),
          idx: ++maxIdx,
          orderItemId: l.orderItemId,
          materialId: l.materialId,
          unitId: l.unitId,
          qty: l.qty,
          warehouseId: headWarehouse,
          remarks: null,
          materialCode: l.materialCode,
          materialName: l.materialName,
          materialSpec: l.materialSpec,
          customerPartNo: l.customerPartNo,
          unitName: l.unitName,
          orderNo: l.orderNo,
          orderQty: l.orderQty,
          baseQty: l.baseQty,
        }),
      )
      if (newRows.length > 0) onGenerated(newRows)

      // 7. 两档反馈:全干净 → sonner;有任何注意项 → 弹框三组
      if (result.unallocated.length === 0 && result.mismatched.length === 0) {
        toast.success(
          newRows.length > 0
            ? `已从装箱清单生成 ${newRows.length} 行发货条目`
            : '没有需要生成的发货条目',
        )
      } else {
        setReport(result)
      }
    } catch (error) {
      toastError('从装箱清单获取失败')(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {noPackLines ? (
        <span className="text-xs text-muted">先在「装箱清单」页签录入装箱行</span>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        isDisabled={noPackLines || busy}
        isPending={busy}
        onPress={() => void run()}
      >
        从装箱清单获取
      </Button>
      {report != null ? (
        <Modal.Backdrop isOpen onOpenChange={(open) => !open && setReport(null)}>
          <Modal.Container>
            <Modal.Dialog className="max-w-2xl">
              <Modal.Header>
                <Modal.Heading>从装箱清单获取:结果</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <div className="flex flex-col gap-4 text-sm">
                  {report.lines.length > 0 ? (
                    <section>
                      <h3 className="mb-1 font-medium">已生成({report.lines.length} 行)</h3>
                      <ul className="flex flex-col gap-0.5 text-muted">
                        {report.lines.map((l, i) => (
                          <li key={i}>
                            {[l.materialCode, l.materialName].filter(Boolean).join(' ') || l.materialId}
                            {' → '}
                            {l.orderNo ?? l.orderItemId} {l.qty} {l.unitName}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {report.unallocated.length > 0 ? (
                    <section>
                      <h3 className="mb-1 font-medium text-danger">
                        未分配(审核前需人工处理)
                      </h3>
                      <ul className="flex flex-col gap-0.5 text-muted">
                        {report.unallocated.map((u) => (
                          <li key={u.materialId}>
                            {u.label}:
                            {u.reason === 'shortfall'
                              ? `装箱 ${u.packed},仅分配 ${u.allocated},余 ${u.remainder} 未分配`
                              : u.reason === 'currency-mismatch'
                                ? `候选订单币种与本单(${u.currencyCode ?? '?'})不一致,未生成`
                                : '无可用订单条目,未生成'}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {report.mismatched.length > 0 ? (
                    <section>
                      <h3 className="mb-1 font-medium text-warning">
                        已有条目与装箱对不上(未改动)
                      </h3>
                      <ul className="flex flex-col gap-0.5 text-muted">
                        {report.mismatched.map((m) => (
                          <li key={m.materialId}>
                            {m.label}:已有发货 {m.itemsBase} ≠ 装箱 {m.packedBase}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button onPress={() => setReport(null)}>知道了</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </>
  )
}

/**
 * 装箱清单 tab 面板(真实组件,内部可用 hook)。
 * 装箱物料候选 = 可发货订单条目池去重物料——不再依赖本单发货条目,
 * 支持「先录装箱、后用按钮生成发货条目」的逆向动线(规格 delivery-pack-first-ux)。
 */
function PackLinesPanel({
  mode,
  row,
  values,
  detailLoaded,
  submitting,
  packBoxes,
  packLines,
  boxErrors,
  lineErrors,
  onBoxesChange,
  onLinesChange,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  detailLoaded: boolean
  submitting: boolean
  packBoxes: Row[]
  packLines: Row[]
  boxErrors?: Record<string, string[]>
  lineErrors?: Record<string, string[]>
  onBoxesChange: (rows: Row[]) => void
  onLinesChange: (rows: Row[]) => void
}) {
  const headerReady = Boolean(values.companyId && values.partyType && values.partyId)
  const readOnly =
    submitting ||
    mode === 'view' ||
    (row != null && row.status !== 'DRAFT') ||
    (mode !== 'create' && !detailLoaded)
  const [pendingDeleteBox, setPendingDeleteBox] = useState<Row | null>(null)
  const poolQuery = deliveryPackPoolQuery(values)
  const pool = useQuery({
    queryKey: poolQuery.queryKey,
    enabled: poolQuery.enabled,
    staleTime: 30_000,
    queryFn: poolQuery.queryFn,
  })

  const materialOptions = useMemo(() => {
    const map = new Map<string, Row>()
    for (const r of pool.data ?? []) {
      if (r.materialId == null || r.materialId === '') continue
      const key = String(r.materialId)
      if (!map.has(key)) map.set(key, r)
    }
    return Array.from(map.values())
  }, [pool.data])

  // 箱:本地行(local: id),保存时先落库由服务端按单内自增取号
  const addBox = () => onBoxesChange([...packBoxes, { id: localRowId() } as Row])
  const removeBox = (box: Row) => {
    onBoxesChange(packBoxes.filter((b) => b.id !== box.id))
    onLinesChange(packLines.filter((l) => !lineInBox(l, box.id)))
  }
  const lineInBox = (l: Row, boxId: unknown) => String(l.packBoxId) === String(boxId)
  const linesOf = (box: Row) => packLines.filter((l) => lineInBox(l, box.id))

  // 装箱行录入:物料(可发货订单条目池)+单位(默认/转换)+数量;所属箱由所在分组决定,
  // 快照与 base 折算由后端保存时重拍
  const packFields: Record<string, FieldOverride> = {
    idx: { visible: () => false },
    packBoxId: { visible: () => false },
    qty: { order: 1, cols: 6, required: true, label: '装箱数量' },
    materialId: {
      order: 2,
      required: true,
      label: '物料',
      input: ({ value, onChange, isDisabled, patchValues: patchLine }) => (
        <Select
          isDisabled={isDisabled || pool.isPending || materialOptions.length === 0}
          value={value == null || value === '' ? null : String(value)}
          onChange={(v) => {
            const id = v === '' ? null : String(v)
            const picked =
              id == null
                ? null
                : (materialOptions.find((m) => String(m.materialId) === id) ?? null)
            onChange(id)
            patchLine({
              materialCode: picked?.materialCode ?? null,
              materialName: picked?.materialName ?? null,
              materialSpec: picked?.materialSpec ?? null,
              customerPartNo: picked?.customerPartNo ?? null,
              // 换物料重置单位(MaterialUnitSelect 会带出新默认单位)
              unitId: null,
              unitName: null,
            })
          }}
        >
          <Label>物料(可发货订单条目)</Label>
          <Select.Trigger>
            <Select.Value>
              {({ isPlaceholder, defaultChildren }) =>
                isPlaceholder
                  ? pool.isPending
                    ? '加载可发货订单条目…'
                    : materialOptions.length === 0
                      ? '无可发货订单条目'
                      : '选择物料…'
                  : defaultChildren
              }
            </Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {materialOptions.map((m) => {
                const code = m.materialCode != null ? String(m.materialCode) : ''
                const name = m.materialName != null ? String(m.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '未名物料'
                return (
                  <ListBox.Item
                    key={String(m.materialId)}
                    id={String(m.materialId)}
                    textValue={text}
                  >
                    {text}
                  </ListBox.Item>
                )
              })}
            </ListBox>
          </Select.Popover>
        </Select>
      ),
    },
    materialName: {
      order: 3,
      label: '物料信息',
      input: ({ values: lv }) => {
        const code = lv.materialCode != null ? String(lv.materialCode) : ''
        const name = lv.materialName != null ? String(lv.materialName) : ''
        const text = [code, name].filter(Boolean).join(' ') || '选物料后自动带出'
        return <LockedText label="物料信息" value={text} />
      },
    },
    materialSpec: {
      order: 4,
      cols: 6,
      label: '规格',
      input: ({ values: lv }) => (
        <LockedText
          label="规格"
          value={lv.materialSpec != null ? String(lv.materialSpec) : '—'}
        />
      ),
    },
    customerPartNo: {
      order: 5,
      cols: 6,
      label: '客户料号',
      input: ({ values: lv }) => (
        <LockedText
          label="客户料号"
          value={lv.customerPartNo != null ? String(lv.customerPartNo) : '—'}
        />
      ),
    },
    unitId: {
      order: 6,
      cols: 6,
      required: true,
      label: '单位',
      input: ({ value, onChange, isDisabled, values: lv }) => (
        <MaterialUnitSelect
          materialId={lv.materialId == null ? null : String(lv.materialId)}
          value={value}
          onChange={onChange}
          isDisabled={isDisabled}
        />
      ),
    },
    baseQty: {
      order: 7,
      cols: 6,
      label: '折算数量',
      input: ({ value, values: lv }) => (
        <LiveBaseQtyField
          materialId={lv.materialId == null ? null : String(lv.materialId)}
          unitId={lv.unitId}
          qty={lv.qty}
          value={value}
        />
      ),
    },
    remarks: { order: 8, label: '行备注' },
    materialCode: { visible: () => false },
    unitName: { visible: () => false },
  }

  const renderBoxTable = (box: Row) => {
    const lines = linesOf(box)
    const boxLabel = box.boxNo != null ? `箱 ${box.boxNo}` : '新箱(保存后系统编号)'
    return (
      <SynieEditableTable
        key={box.id}
        resource="salDeliveryPackLines"
        label="装箱行"
        title={
          <span className="flex flex-col gap-0.5">
            <span>{boxLabel}</span>
            {boxErrors?.[String(box.id)]?.length ? (
              <span className="text-xs font-normal text-danger" role="alert">
                {boxErrors[String(box.id)].join('；')}
              </span>
            ) : null}
          </span>
        }
        items={lines}
        rowErrors={lineErrors}
        onChange={(rows) =>
          onLinesChange([...packLines.filter((l) => !lineInBox(l, box.id)), ...rows])
        }
        readOnly={readOnly}
        canCreate={headerReady}
        toolbar={
          !readOnly ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => (lines.length > 0 ? setPendingDeleteBox(box) : removeBox(box))}
            >
              删除箱
            </Button>
          ) : undefined
        }
        drawerClassName="w-full lg:w-[560px]"
        exclude={['deliveryId', 'companyId']}
        columns={['idx', 'materialName', 'unitName', 'qty', 'baseQty', 'remarks']}
        overrides={{
        // 物料列:全站统一富单元格(装箱行无图纸挂接,缩略图回退物料当前图纸)
        materialName: {
          label: '物料',
          className: 'min-w-[12rem] max-w-[18rem]',
          render: materialCellRender(),
        },
        unitName: { label: '单位' },
        baseQty: { label: '折算数量' },
        remarks: { label: '行备注' },
        }}
        fields={packFields}
        validateItem={(vals) => {
          if (!vals.materialId) return '请选择物料'
          if (!vals.unitId) return '请选择单位'
          if (!(Number(vals.qty) > 0)) return '数量必须大于零'
        }}
        transformItem={(vals, editing) => {
          const picked =
            vals.materialId != null
              ? materialOptions.find((m) => String(m.materialId) === String(vals.materialId))
              : undefined
          const unitKept =
            editing != null && String(vals.unitId ?? '') === String(editing.unitId ?? '')
          const qtyKept =
            editing != null && String(vals.qty ?? '') === String(editing.qty ?? '')
          return {
            ...vals,
            // 所属箱由所在分组决定(行表单不再出现箱字段)
            packBoxId: box.id,
            idx: editing
              ? editing.idx
              : packLines.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
            materialCode:
              picked?.materialCode ?? editing?.materialCode ?? vals.materialCode ?? null,
            materialName:
              picked?.materialName ?? editing?.materialName ?? vals.materialName ?? null,
            materialSpec:
              picked?.materialSpec ?? editing?.materialSpec ?? vals.materialSpec ?? null,
            customerPartNo:
              picked?.customerPartNo ??
              editing?.customerPartNo ??
              vals.customerPartNo ??
              null,
            // 单位/数量变更后快照名与折算量待后端保存时重拍
            ...(unitKept ? {} : { unitName: null }),
            ...(unitKept && qtyKept ? {} : { baseQty: null }),
          }
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 border-b border-separator pb-2">
        <span className="text-sm font-medium">装箱清单</span>
        <div className="flex items-center gap-2">
          {!readOnly && !headerReady ? (
            <span className="text-xs text-muted">先选齐公司、对手类型与对手</span>
          ) : null}
          {!readOnly ? (
            <Button size="sm" variant="secondary" onPress={addBox} isDisabled={!headerReady}>
              添加箱子
            </Button>
          ) : null}
        </div>
      </div>
      {packBoxes.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">
          {readOnly ? '本单无装箱记录' : '尚未装箱,点击右上角「添加箱子」开始录入'}
        </p>
      ) : (
        <div className="flex flex-col gap-5">{packBoxes.map(renderBoxTable)}</div>
      )}
      {pendingDeleteBox != null ? (
        <Modal.Backdrop isOpen onOpenChange={(open) => !open && setPendingDeleteBox(null)}>
          <Modal.Container>
            <Modal.Dialog className="max-w-md">
              <Modal.Header>
                <Modal.Heading>删除箱</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm">
                  {pendingDeleteBox.boxNo != null ? `箱 ${pendingDeleteBox.boxNo}` : '该新箱'}
                  内有 {linesOf(pendingDeleteBox).length} 行装箱记录,删除箱将一并删除这些行。确定删除?
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="ghost" onPress={() => setPendingDeleteBox(null)}>
                  取消
                </Button>
                <Button
                  variant="danger"
                  onPress={() => {
                    removeBox(pendingDeleteBox)
                    setPendingDeleteBox(null)
                  }}
                >
                  删除
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </div>
  )
}

/**
 * 销售发货创建/编辑抽屉(头+条目+装箱)。
 * 发货单/发货条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function DeliveryDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 订单条目缓存:选择时写入完整行,transformItem 带出快照名
  const orderItemsRef = useRef(new Map<string, Row>())
  const draftHeadRef = useRef<Record<string, unknown>>({})
  // 保存后身份切换占号:acceptSavedDraft 先写缓存再切 recordId,骨架装载直取,不双发 loadDraft
  const savedDraftsRef = useRef(new Map<string, SalesDeliverySavedDraft>())
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<SalesDeliverySavedDraft>({
    resource: 'salDeliveries',
    urlSync,
    loadDraft: (id) => {
      const cached = savedDraftsRef.current.get(id)
      if (cached) {
        savedDraftsRef.current.delete(id)
        return Promise.resolve(cached)
      }
      return salesDeliveryDraft.loadDraft(id)
    },
  })
  const { isOpen, mode, rowId } = drawer
  const [items, setItems] = useState<Row[]>([])
  const [packBoxes, setPackBoxes] = useState<Row[]>([])
  const [packLines, setPackLines] = useState<Row[]>([])
  const [draftErrors, setDraftErrors] = useState<Record<string, string[]>>({})
  const [draftErrorIndex, setDraftErrorIndex] = useState<DeliveryDraftIndex | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [filters] = useState<FilterState>({})
  const queryClient = useQueryClient()
  // 编辑入口:权威草稿优先(保存后立即有 status),其次 URL 自查行 / 本地 open 入参
  const deliveryStatus = drawer.draft?.status ?? drawer.row?.status

  const companies = useQuery({
    queryKey: ['salDeliveries', 'companies'],
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

  const resetItems = useCallback(() => {
    setDraftErrors({})
    setItems((cur) => (cur.length === 0 ? cur : []))
    // 装箱行物料来自发货条目:条目清空时一并清空箱与行
    setPackBoxes((cur) => (cur.length === 0 ? cur : []))
    setPackLines((cur) => (cur.length === 0 ? cur : []))
  }, [])

  // 草稿 → 条目/装箱集合派生:draft 变化(含关闭/新建清空为 null)时初始化三个集合,
  // 预热订单条目缓存并写 draftHeadRef(onSubmit 合并头字段用)
  useEffect(() => {
    const saved = drawer.draft
    draftHeadRef.current = saved ?? {}
    const itemRows = saved?.items ?? []
    const boxRows = saved?.packBoxes ?? []
    const lineRows = boxRows.flatMap((box) =>
      box.lines.map((line) => ({ ...line, packBoxId: box.id })),
    )
    // 编辑态预热缓存:存量行不必再点选订单条目也能过校验/回填
    const cache = new Map<string, Row>()
    for (const r of itemRows) {
      if (r.orderItemId != null) {
        cache.set(String(r.orderItemId), {
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
    orderItemsRef.current = cache
    setDraftErrors({})
    setItems(itemRows)
    setPackBoxes(boxRows)
    setPackLines(lineRows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenDeliveryDrawer = (nextMode, delivery) => {
    drawer.open(nextMode, delivery)
  }

  const acceptSavedDraft = (saved: SalesDeliverySavedDraft) => {
    setDraftErrors({})
    setDraftErrorIndex(null)
    // 先写占号缓存,再切身份:骨架按 recordId 装载时命中缓存,避免深链 effect 双发 loadDraft
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
  const boxErrors = rowErrors(
    draftErrors,
    /^packBoxes\[(\d+)\](?!\.lines\[)(?:\.(.+))?$/,
    (boxIndex) => {
      const id = draftErrorIndex?.boxRowIds[boxIndex]
      return id == null ? undefined : packBoxes.find((row) => String(row.id) === id)
    },
  )
  const lineErrors = rowErrors(
    draftErrors,
    /^packBoxes\[(\d+)\]\.lines\[(\d+)\](?:\.(.+))?$/,
    (boxIndex, lineIndex) => {
      const id = draftErrorIndex?.lineRowIds[boxIndex]?.[lineIndex]
      return id == null ? undefined : packLines.find((row) => String(row.id) === id)
    },
  )
  const submissionErrorTab =
    Object.keys(draftErrors).length === 0
      ? null
      : Object.keys(draftErrors).some((path) =>
          normalizedErrorPath(path).startsWith('packBoxes'),
        )
        ? 'pack'
        : 'info'

  const baseCfg = drawerConfig('salDeliveries')
  const drawerCfg = {
    ...baseCfg,
    // 两 tab:发货信息(头字段+条目+借贷科目,首 tab 走 extraContent)、
    // 装箱清单(装箱行独占,tabExtraContent);装箱清单为可选子表,不恒占一屏
    tabs: [
      { key: 'info', label: '发货信息' },
      {
        key: 'pack',
        label: packLines.length > 0 ? `装箱清单 (${packLines.length})` : '装箱清单',
      },
    ],
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
      deliveryDate: { ...baseCfg.fields?.deliveryDate, defaultValue: todayLocal() },
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
    <DeliveryDrawerContext.Provider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="salDeliveries"
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
        submissionErrorTab={submissionErrorTab}
        keepOpenOnAuditFailure
        onEdit={
          deliveryStatus === 'DRAFT' ? () => drawer.setMode('edit') : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          draftHeadRef.current = values
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
                  resource="salOrderItems"
                  label="订单条目"
                  dialogTitle="选择可发货订单条目"
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
                    'shippedQty',
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
                          row = (await salesOrderItemClient.get(id)) ?? row
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
                    'qty',
                    'shippedQty',
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
                    qty: { label: '订购数量' },
                    shippedQty: { label: '已发数量' },
                    remainingBaseQty: { label: '未发数量' },
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
            qty: { order: 5, cols: 6, required: true, label: '发货数量' },
            warehouseId: {
              order: 6,
              required: true,
              label: '出库仓库',
              // 新建行默认带出头上「默认仓库」(用户仍可改)
              defaultValue:
                headWarehouse == null || headWarehouse === '' ? null : String(headWarehouse),
              input: ({ value, onChange, isDisabled }) => (
                <WarehouseRemoteSelect
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  companyId={companyId}
                  label="出库仓库"
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
              <DeliveryAccountDefaultSync
                key={`acct-${rowId ?? 'create'}-${drawer.generation}`}
                mode={mode}
                companyId={companyId}
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
                resource="salDeliveryItems"
                label="发货条目"
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
                  ) : (
                    <GenerateFromPackButton
                      values={values}
                      packLines={packLines}
                      items={items}
                      orderItemsRef={orderItemsRef}
                      onGenerated={(rows) => {
                        setDraftErrors({})
                        setItems((cur) => [...cur, ...rows])
                      }}
                    />
                  )
                }
                drawerClassName="w-full lg:w-[560px]"
                exclude={[
                  'deliveryId',
                  'companyId',
                  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
                  'deliveryNo',
                  'deliveryDate',
                  'deliveryStatus',
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
                  // 物料列:全站统一富单元格(图纸缩略图+快照四字段);行图纸挂接优先
                  materialName: {
                    label: '物料',
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: materialCellRender({ drawingOwnerType: 'sal_delivery_item' }),
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
                  if (!vals.warehouseId) return '请选择出库仓库'
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
              <DeliveryAccountFooter
                mode={mode}
                values={values}
                patchValues={patchValues}
                isDisabled={
                  mode === 'view' || (row != null && row.status !== 'DRAFT')
                }
                fieldErrors={fieldErrors}
              />
            </>
          )
        }}
        tabExtraContent={{
          pack: (mode, row, values) => {
            draftHeadRef.current = values
            return (
              <PackLinesPanel
                mode={mode}
                row={row}
                values={values}
                detailLoaded={drawer.detailLoaded}
                submitting={submitting}
                packBoxes={packBoxes}
                packLines={packLines}
                boxErrors={boxErrors}
                lineErrors={lineErrors}
                onBoxesChange={(rows) => {
                  setDraftErrors({})
                  setPackBoxes(rows)
                }}
                onLinesChange={(rows) => {
                  setDraftErrors({})
                  setPackLines(rows)
                }}
              />
            )
          },
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          assertAggregateDraftReady(mode, drawer.detailLoaded, '发货明细')
          // 表单只经 AggregateDraftAdapter；binding 不挂 create/update writer
          const writerBag = salesDeliveryBinding.writer as
            | Partial<{ create: unknown; update: unknown }>
            | undefined
          if (writerBag?.create || writerBag?.update) {
            throw new Error('销售发货表单不得暴露 RecordWriter create/update')
          }
          const request = buildDeliveryDraft(
            { ...draftHeadRef.current, ...values },
            items,
            packBoxes,
            packLines,
          )
          setDraftErrors({})
          setDraftErrorIndex(request.index)
          setSubmitting(true)
          try {
            const saved =
              mode === 'create'
                ? await salesDeliveryDraft.createDraft(request.draft)
                : await salesDeliveryDraft.replaceDraft(
                    rowId!,
                    request.draft,
                  )
            acceptSavedDraft(saved)
            queryClient.setQueryData(
              salesDeliveryBinding.cache.rowKey(String(saved.id)),
              saved,
            )
            await Promise.all([
              salesDeliveryBinding.cache.invalidateGrid(queryClient),
              resourceBindingFor('salDeliveryItems').cache.invalidateGrid(
                queryClient,
              ),
              resourceBindingFor(
                'salDeliveryPackBoxes',
              ).cache.invalidateGrid(queryClient),
              resourceBindingFor(
                'salDeliveryPackLines',
              ).cache.invalidateGrid(queryClient),
              resourceBindingFor('salOrderItems').cache.invalidateGrid(
                queryClient,
              ),
              queryClient.invalidateQueries({
                queryKey: ['deliveryPackPool'],
              }),
            ])
            toast.success(`销售发货单已${mode === 'create' ? '创建' : '更新'}`)
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
    </DeliveryDrawerContext.Provider>
  )
}
