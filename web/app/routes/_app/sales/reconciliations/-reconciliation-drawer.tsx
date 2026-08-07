import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Input,
  Label,
  NumberField,
  TextField,
  Button,
  toast,
} from '@heroui/react'
import { formatAmount, formatQty } from '~/lib/amount'
import { companyClient } from '~/lib/resources/companies'
import { salesDeliveryItemClient } from '~/lib/resources/fulfillment'
import {
  salesReconciliationClient,
  salesReconciliationItemClient,
} from '~/lib/resources/reconciliations'
import { resourceBindingFor } from '~/lib/resources/registry'
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
import { fetchCompanyAccountDefaults } from '~/components/company-account-defaults'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { persistChildRows } from '~/lib/resources/persist-child-rows'
import { toastError } from '~/lib/toast'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

export interface ReconciliationRef {
  id: string
  status?: unknown
}

export type OpenReconciliationDrawer = (
  mode: DrawerMode,
  reconciliation: ReconciliationRef | null,
) => void

const AUDIT_COLUMNS: AuditDocConfig['columns'] = [
  { key: 'deliveryNo', label: '发货单号' },
  {
    key: 'materialName',
    label: '物料',
    render: auditMaterialCell(),
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
  resource: 'salReconciliations',
  commandKey: 'confirm',
  itemsResource: 'salReconciliationItems',
  columns: AUDIT_COLUMNS,
  loadItems: (reconciliationId: string) =>
    salesReconciliationItemClient
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
  docLabel: '销售对账单',
  resource: 'salReconciliations',
  commandKey: 'audit',
  itemsResource: 'salReconciliationItems',
  columns: AUDIT_COLUMNS,
  loadItems: reconciliationConfirmConfig.loadItems,
} satisfies AuditDocConfig

const {
  useOpen: useReconciliationDrawer,
  Provider: ReconciliationDrawerOpenProvider,
} = createDocumentDrawerOpenBridge<OpenReconciliationDrawer>()
export { useReconciliationDrawer }


/** 提交 mutation:金额/baseQty 由后端按金额链与折算比例算(不可手改) */
function itemInput(row: Row) {
  return {
    idx: row.idx,
    deliveryItemId: row.deliveryItemId,
    qty: row.qty,
    remarks: row.remarks ?? null,
  }
}

async function persistItems(
  reconciliationId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: salesReconciliationItemClient,
    parentIdField: 'reconciliationId',
    parentId: reconciliationId,
    compareKeys: ['idx', 'deliveryItemId', 'qty', 'remarks'],
    inputOf: itemInput,
  })
}

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
        label={debitLabel}
        placeholder={companyId ? `选择${debitLabel}…` : '先选择公司'}
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
        label="贷方科目(未开票应收)"
        placeholder={companyId ? '选择未开票应收科目…' : '先选择公司'}
        value={credit}
        onChange={(id) => patchValues({ creditAccountId: id })}
        isDisabled={isDisabled || !companyId || mode === 'view'}
        isRequired={mode !== 'view'}
        filterState={accountFilter(companyId, 'UNBILLED_RECEIVABLE')}
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
 * 5. 常规单:禁零金额行、禁样品订单来源；后端均另有强校验。
 * 使用结构化 REST FilterState；orderType 是履约查询专供候选池的内部筛选字段，
 * 不扩张迁移前 GridMeta。
 */
function deliveryItemGridFilter(
  values: Record<string, unknown>,
  items: Row[],
): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  const currency = items.find(
    (r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '',
  )?.orderCurrencyCode
  return {
    deliveryStatus: { kind: 'enum', values: ['AUDITED'] },
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
          orderType: { kind: 'enum' as const, values: ['REGULAR'] },
        }
      : {}),
  }
}

function deliveryItemDisplay(r: Row): string {
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
  const deliveryNo =
    r.deliveryNo != null && r.deliveryNo !== '' ? String(r.deliveryNo) : null
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

/** 对账条目行集合 + 发货条目预热缓存(骨架 loadDraft 的返回形) */
interface ReconciliationLinesDraft {
  items: Row[]
  deliveryItems: Map<string, Row>
}

/**
 * 销售对账创建/编辑抽屉(头+对账条目)。
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
  const drawer = useDocumentDrawer<ReconciliationLinesDraft>({
    resource: 'salReconciliations',
    urlSync,
    loadDraft: async (reconciliationId) => {
      const d = await salesReconciliationItemClient.query({
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
      const rows = d.results
      // 编辑态预热缓存:按行上发货条目 id 取剩余可对账量/快照价/币种
      const ids = [
        ...new Set(
          rows
            .map((r) =>
              r.deliveryItemId == null ? null : String(r.deliveryItemId),
            )
            .filter((v): v is string => v != null),
        ),
      ]
      const deliveryItems = new Map<string, Row>()
      if (ids.length > 0) {
        try {
          const data = await Promise.all(
            ids.map((id) => salesDeliveryItemClient.get(id)),
          )
          for (const di of data.filter((row): row is Row => row != null)) {
            deliveryItems.set(String(di.id), di)
          }
        } catch {
          /* 预热失败不挡开单:行仍可看,剩余量校验由后端兜底 */
        }
      }
      // 行上缺的物料编号/规格/客户料号从预热缓存补齐(表格多行展示用)
      const items = rows.map((r) => {
        const di =
          r.deliveryItemId != null
            ? deliveryItems.get(String(r.deliveryItemId))
            : undefined
        if (!di) return r
        return {
          ...r,
          materialCode: r.materialCode ?? di.materialCode ?? null,
          materialSpec: r.materialSpec ?? di.materialSpec ?? null,
          customerPartNo: r.customerPartNo ?? di.customerPartNo ?? null,
        }
      })
      return { items, deliveryItems }
    },
  })
  const { isOpen, mode, rowId } = drawer
  const reconciliationStatus = drawer.row?.status
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [importing, setImporting] = useState(false)
  const [filters] = useState<FilterState>({})
  // 发货条目缓存:选择时写入完整行,validateItem/transformItem 带剩余量与快照价
  const deliveryItemsRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()

  const companies = useQuery({
    queryKey: ['salReconciliations', 'companies'],
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

  const resetItems = useCallback(
    () => setItems((cur) => (cur.length === 0 ? cur : [])),
    [],
  )

  // 草稿 → 条目状态派生:draft 变化(含关闭/新建清空为 null)时初始化条目及其保存比对基线,并重建发货条目缓存
  useEffect(() => {
    deliveryItemsRef.current = drawer.draft?.deliveryItems ?? new Map()
    const rows = drawer.draft?.items ?? []
    setItems(rows)
    setItemsSnapshot(rows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenReconciliationDrawer = (nextMode, reconciliation) => {
    drawer.open(nextMode, reconciliation)
  }

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
    <ReconciliationDrawerOpenProvider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="salReconciliations"
        {...drawerCfg}
        mode={mode}
        isOpen={isOpen}
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
          const diGridFilter = deliveryItemGridFilter(values, items)
          const docCurrency =
            items.find(
              (r) => r.orderCurrencyCode != null && r.orderCurrencyCode !== '',
            )?.orderCurrencyCode ?? null

          // 「导入所有未对账」:按选择弹窗同口径(diGridFilter)拉全部候选,
          // 跳过已在清单的发货条目,数量默认=剩余可对账量(折行单位)
          const importAllUnreconciled = async () => {
            if (!diGridFilter) return
            setImporting(true)
            try {
              const candidates: Row[] = []
              let offset = 0
              for (;;) {
                const page = await salesDeliveryItemClient.query({
                  limit: 200,
                  offset,
                  sort: { column: 'deliveryDate', direction: 'ascending' },
                  filter: diGridFilter,
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
              const listed = new Set(items.map((r) => String(r.deliveryItemId)))
              const fresh = candidates.filter(
                (di) => !listed.has(String(di.id)),
              )
              if (fresh.length === 0) {
                toast.warning('没有可导入的未对账发货条目')
                return
              }
              // 清单为空时 filter 未钉币种:候选跨币种则无法保证单内同币种,先手工选一行钉住
              if (
                items.length === 0 &&
                new Set(fresh.map((di) => String(di.orderCurrencyCode ?? '')))
                  .size > 1
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
              const imported = fresh.map((di) => {
                deliveryItemsRef.current.set(String(di.id), di)
                const remaining = Number(di.remainingReconcilableQty)
                const ratio =
                  Number(di.baseQty) > 0
                    ? Number(di.qty) / Number(di.baseQty)
                    : 1
                // 数量默认=剩余可对账量(折行单位,6 位去尾差);金额按金额链 2 位预览,落库以后端为准
                const qty = Math.round(remaining * ratio * 1e6) / 1e6
                return {
                  id: localRowId(),
                  idx: ++maxIdx,
                  deliveryItemId: di.id,
                  qty,
                  remarks: null,
                  materialCode: di.materialCode ?? null,
                  materialName: di.materialName ?? null,
                  materialSpec: di.materialSpec ?? null,
                  customerPartNo: di.customerPartNo ?? null,
                  unitName: di.unitName ?? null,
                  deliveryNo: di.deliveryNo ?? null,
                  orderCurrencyCode: di.orderCurrencyCode ?? null,
                  amount: previewAmount(qty, di.orderPrice),
                  baseAmount: previewAmount(qty, di.orderBasePrice),
                }
              })
              setItems((cur) => [...cur, ...imported])
              toast.success(`已导入 ${imported.length} 条未对账发货条目`)
            } catch (e) {
              toastError('导入未对账条目失败')(e)
            } finally {
              setImporting(false)
            }
          }

          // 条目录入:弹窗选发货条目后锁定回填物料/单位/币种快照;用户只填数量/行备注
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            deliveryItemId: {
              order: 0,
              required: true,
              label: '发货条目',
              input: ({
                value,
                onChange,
                isDisabled,
                patchValues: patchItem,
              }) => (
                <RemoteDialogSelect
                  resource="salDeliveryItems"
                  label="发货条目"
                  dialogTitle="选择可对账发货条目"
                  placeholder={
                    diGridFilter ? '点击选择发货条目…' : '先选齐公司与对手'
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
                    'deliveryNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, ditem) => {
                    if (id && ditem)
                      deliveryItemsRef.current.set(String(id), ditem)
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
                    qty: {
                      label: '发货数量',
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
                    column: 'deliveryDate',
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
                  renderValue={(r) => deliveryItemDisplay(r)}
                />
              ),
            },
            // 物料/单位/币种只读回显(值由发货条目 patch 写入)
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
                  '选发货条目后自动带出'
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
                      : '选发货条目后自动带出'
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
                const ditem =
                  iv.deliveryItemId != null
                    ? deliveryItemsRef.current.get(String(iv.deliveryItemId))
                    : undefined
                const preview =
                  value != null && value !== ''
                    ? value
                    : previewAmount(iv.qty, ditem?.orderPrice)
                return (
                  <LockedNumber
                    label="金额(原币含税,数量×快照单价)"
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
                resource="salReconciliationItems"
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
                  // 物料列:全站统一富单元格(编号/名称/规格/客户料号随受控行在表上)。
                  // 对账行 meta 无 materialId 也无图纸挂接:编号退纯文本、缩略图显占位
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
                  if (!vals.deliveryItemId) return '请选择发货条目'
                  if (
                    curItems.some(
                      (r) =>
                        r.id !== editing?.id &&
                        r.deliveryItemId != null &&
                        String(r.deliveryItemId) ===
                          String(vals.deliveryItemId),
                    )
                  )
                    return '该发货条目已在清单中'
                  if (!(Number(vals.qty) > 0)) return '对账数量必须大于零'
                  // 单内同币种:以首个他行币种为基准(弹窗已过滤,这里双保险)
                  const ditem = deliveryItemsRef.current.get(
                    String(vals.deliveryItemId),
                  )
                  const rowCurrency =
                    ditem?.orderCurrencyCode ??
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
                      ? deliveryItemsRef.current.get(
                          String(vals.deliveryItemId),
                        )
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
                      : items.reduce(
                          (max, r) => Math.max(max, Number(r.idx) || 0),
                          0,
                        ) + 1,
                    materialCode: pick('materialCode'),
                    materialName: pick('materialName'),
                    materialSpec: pick('materialSpec'),
                    customerPartNo: pick('customerPartNo'),
                    unitName: pick('unitName'),
                    deliveryNo: pick('deliveryNo'),
                    orderCurrencyCode: pick('orderCurrencyCode'),
                    amount:
                      previewAmount(qty, ditem?.orderPrice) ??
                      (editing &&
                      String(editing.deliveryItemId) ===
                        String(vals.deliveryItemId)
                        ? editing.amount
                        : null),
                    baseAmount:
                      previewAmount(qty, ditem?.orderBasePrice) ??
                      (editing &&
                      String(editing.deliveryItemId) ===
                        String(vals.deliveryItemId)
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
                isDisabled={
                  mode === 'view' || (row != null && row.status !== 'DRAFT')
                }
              />
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const created = await salesReconciliationClient.create(values)
            const reconciliationId = String(created.id)
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
            await salesReconciliationClient.update(rowId!, values)
            const itemErrors = await persistItems(
              rowId!,
              items,
              itemsSnapshot,
            )
            if (itemErrors.length > 0) {
              toast.danger('销售对账单已更新,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('销售对账单已更新')
            }
            savedId = rowId!
          }
          await Promise.all([
            resourceBindingFor('salReconciliations').cache.invalidateAll(
              queryClient,
            ),
            resourceBindingFor(
              'salReconciliationItems',
            ).cache.invalidateGrid(queryClient),
          ])
          return savedId
        }}
      />
    </ReconciliationDrawerOpenProvider>
  )
}
