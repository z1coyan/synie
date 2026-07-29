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
import {
  salesDeliveryClient,
  salesDeliveryItemClient,
  salesDeliveryPackLineClient,
} from '~/lib/resources/fulfillment'
import { salesOrderItemClient } from '~/lib/resources/orders'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
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
import { auditMaterialCell, type AuditDocConfig } from '../-audit-doc'
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from '../-stock-doc'
import { fetchCompanyAccountDefaults } from '../settings/-company-account-defaults'

export interface DeliveryRef {
  id: string
  status?: unknown
}

export type OpenDeliveryDrawer = (mode: DrawerMode, delivery: DeliveryRef | null) => void

// 「审核整单」确认弹窗配置:条目页行操作与发货单页「审核」动作共用(见 scm/-audit-doc)
export const deliveryAuditConfig = {
  docLabel: '销售发货单',
  itemsResource: 'salDeliveryItems',
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ key: 'customerPartNo', label: '客户料号' }),
    },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '发货数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
  loadItems: (deliveryId: string) =>
    salesDeliveryItemClient
      .query({
        limit: 500,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: {
          deliveryId: { kind: 'fk', op: 'in', values: [deliveryId], labels: [] },
        },
      })
      .then((result) => result.results),
  audit: (deliveryId: string) => salesDeliveryClient.action!('audit', [deliveryId]),
} satisfies AuditDocConfig

const DeliveryDrawerContext = createContext<OpenDeliveryDrawer>(() => {})

export function useDeliveryDrawer(): OpenDeliveryDrawer {
  return useContext(DeliveryDrawerContext)
}

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

async function persistItems(
  deliveryId: string,
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
    try {
      await salesDeliveryItemClient.delete(String(old.id))
    } catch (error) {
      collect(old.idx, [{ message: (error as Error).message }])
    }
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      try {
        await salesDeliveryItemClient.create({ deliveryId, ...itemInput(row) })
      } catch (error) {
        collect(row.idx, [{ message: (error as Error).message }])
      }
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      try {
        await salesDeliveryItemClient.update(String(row.id), itemInput(row))
      } catch (error) {
        collect(row.idx, [{ message: (error as Error).message }])
      }
    }
  }
  return errors
}

/** 提交 mutation:快照字段由后端保存时重拍,本地只提交业务键 */
function packLineInput(row: Row) {
  return {
    idx: row.idx,
    boxNo: row.boxNo,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    remarks: row.remarks ?? null,
  }
}

const PACK_COMPARE_KEYS = ['idx', 'boxNo', 'materialId', 'unitId', 'qty', 'remarks'] as const

function packLineChanged(before: Row, after: Row): boolean {
  return PACK_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

async function persistPackLines(
  deliveryId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  const errors: string[] = []
  const collect = (boxNo: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `箱${boxNo ?? '?'}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    try {
      await salesDeliveryPackLineClient.delete(String(old.id))
    } catch (error) {
      collect(old.boxNo, [{ message: (error as Error).message }])
    }
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      try {
        await salesDeliveryPackLineClient.create({ deliveryId, ...packLineInput(row) })
      } catch (error) {
        collect(row.boxNo, [{ message: (error as Error).message }])
      }
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && packLineChanged(old, row)) {
      try {
        await salesDeliveryPackLineClient.update(String(row.id), packLineInput(row))
      } catch (error) {
        collect(row.boxNo, [{ message: (error as Error).message }])
      }
    }
  }
  return errors
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
 * 头关键字段变更清行:公司/对手类型/对手任一变则清空条目草稿
 * (与销售订单 ItemsResetGuard 同构;edit 等行主数据回填后再布防)。
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
      toast.danger('从装箱清单获取失败', { description: (error as Error).message })
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
  packLines,
  onChange,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  detailLoaded: boolean
  packLines: Row[]
  onChange: (rows: Row[]) => void
}) {
  const headerReady = Boolean(values.companyId && values.partyType && values.partyId)
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
  const lastBoxNo =
    packLines.length > 0 ? String(packLines[packLines.length - 1].boxNo ?? '') : ''

  // 装箱行录入:箱号(默认沿用上一行)+物料(可发货订单条目池)+单位(默认/转换)+数量;
  // 快照与 base 折算由后端保存时重拍
  const packFields: Record<string, FieldOverride> = {
    idx: { visible: () => false },
    boxNo: {
      order: 0,
      cols: 6,
      required: true,
      label: '箱号',
      placeholder: '如 A-01',
      defaultValue: lastBoxNo === '' ? null : lastBoxNo,
    },
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

  return (
    <SynieEditableTable
      resource="salDeliveryPackLines"
      client={salesDeliveryPackLineClient}
      label="装箱行"
      title="装箱清单"
      items={packLines}
      onChange={onChange}
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
      exclude={['deliveryId', 'companyId']}
      columns={['idx', 'boxNo', 'materialName', 'unitName', 'qty', 'baseQty', 'remarks']}
      overrides={{
        boxNo: { label: '箱号' },
        materialName: {
          label: '物料',
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
      fields={packFields}
      validateItem={(vals) => {
        if (vals.boxNo == null || String(vals.boxNo).trim() === '') return '请填写箱号'
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
          idx: editing
            ? editing.idx
            : packLines.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
          boxNo: String(vals.boxNo ?? '').trim(),
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

export function DeliveryDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: DeliveryRef | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [packLines, setPackLines] = useState<Row[]>([])
  const [packLinesSnapshot, setPackLinesSnapshot] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [filters] = useState<FilterState>({})
  // 订单条目缓存:选择时写入完整行,transformItem 带出快照名
  const orderItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

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
    setItems((cur) => (cur.length === 0 ? cur : []))
    // 装箱行物料来自发货条目:条目清空时一并清空
    setPackLines((cur) => (cur.length === 0 ? cur : []))
  }, [])

  const openDrawer = useCallback<OpenDeliveryDrawer>((mode, delivery) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row: delivery })
    orderItemsRef.current = new Map()
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setPackLines([])
      setPackLinesSnapshot([])
      setDetailLoaded(true)
      return
    }
    const deliveryId = delivery?.id
    // 防前端把 String(undefined) 当成 uuid 过滤(Invalid filter value "undefined")
    if (deliveryId == null || deliveryId === '' || deliveryId === 'undefined') {
      toast.danger('无法打开发货单', { description: '缺少发货单 id' })
      setItems([])
      setItemsSnapshot([])
      setPackLines([])
      setPackLinesSnapshot([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    const deliveryFilter = {
      deliveryId: { kind: 'fk' as const, op: 'in' as const, values: [deliveryId], labels: [] },
    }
    Promise.all([
      salesDeliveryItemClient.query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: deliveryFilter,
      }),
      salesDeliveryPackLineClient.query({
        limit: 500,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: deliveryFilter,
      }),
    ])
      .then(([itemsResult, packResult]) => {
        if (my !== reqIdRef.current) return
        const rows = itemsResult.results
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
        setPackLines(packResult.results)
        setPackLinesSnapshot(packResult.results)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('发货明细加载失败', { description: (e as Error).message })
        setItems([])
        setItemsSnapshot([])
        setPackLines([])
        setPackLinesSnapshot([])
      })
  }, [])

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
        client={salesDeliveryClient}
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          setPackLines([])
          setPackLinesSnapshot([])
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
                  resource="salOrderItems"
                  client={salesOrderItemClient}
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
                resource="salDeliveryItems"
                client={salesDeliveryItemClient}
                label="发货条目"
                items={items}
                onChange={setItems}
                readOnly={
                  mode === 'view' ||
                  (row != null && row.status !== 'DRAFT') ||
                  (mode !== 'create' && !detailLoaded)
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
                      onGenerated={(rows) => setItems((cur) => [...cur, ...rows])}
                    />
                  )
                }
                drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
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
              />
            </>
          )
        }}
        tabExtraContent={{
          pack: (mode, row, values) => (
            <PackLinesPanel
              mode={mode}
              row={row}
              values={values}
              detailLoaded={detailLoaded}
              packLines={packLines}
              onChange={setPackLines}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const saved = await salesDeliveryClient.create(values)
            const deliveryId = String(saved.id)
            const itemErrors = await persistItems(deliveryId, items, [])
            const packErrors = await persistPackLines(deliveryId, packLines, [])
            const errors = [...itemErrors, ...packErrors]
            if (errors.length > 0) {
              toast.danger('发货单已创建,但部分明细保存失败', {
                description: errors.join('; '),
              })
            } else {
              toast.success('销售发货单已创建')
            }
            savedId = deliveryId
          } else {
            await salesDeliveryClient.update(drawer!.row!.id, values)
            const itemErrors = await persistItems(drawer!.row!.id, items, itemsSnapshot)
            const packErrors = await persistPackLines(
              drawer!.row!.id,
              packLines,
              packLinesSnapshot,
            )
            const errors = [...itemErrors, ...packErrors]
            if (errors.length > 0) {
              toast.danger('发货单已更新,但部分明细保存失败', {
                description: errors.join('; '),
              })
            } else {
              toast.success('销售发货单已更新')
            }
            savedId = drawer!.row!.id
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salDeliveries'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salDeliveryItems'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salDeliveryPackLines'] })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'salDeliveries'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salOrderItems'] })
          return savedId
        }}
      />
    </DeliveryDrawerContext.Provider>
  )
}
