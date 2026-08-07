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
import { companyClient } from '~/lib/resources/companies'
import {
  purchaseOutsourcedIssueClient,
  purchaseOutsourcedIssueItemClient,
} from '~/lib/resources/fulfillment'
import { queryOutsourcedWarehouses } from '~/lib/resources/inventory'
import { purchaseOrderItemMaterialClient } from '~/lib/resources/orders'
import { resourceBindingFor } from '~/lib/resources/registry'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { auditMaterialCell, type AuditDocConfig } from '../../scm/-audit-doc'
import { CompanyDefaultSync, WarehouseRemoteSelect, defaultCompanyId } from '../../scm/-stock-doc'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { todayLocal } from '~/lib/form-defaults'
import { persistChildRows } from '~/lib/resources/persist-child-rows'
import { useDocumentDrawer } from '~/lib/use-document-drawer'

export interface IssueRef {
  id: string
  status?: unknown
}

export type OpenIssueDrawer = (mode: DrawerMode, issue: IssueRef | null) => void

// 「审核整单」确认弹窗配置:条目页行操作与发料单页「审核」动作共用(见 scm/-audit-doc)
export const issueAuditConfig = {
  docLabel: '委外发料单',
  resource: 'purOutsourcedIssues',
  commandKey: 'audit',
  itemsResource: 'purOutsourcedIssueItems',
  columns: [
    { key: 'materialName', label: '材料', render: auditMaterialCell() },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '发料数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
  loadItems: (issueId: string) =>
    purchaseOutsourcedIssueItemClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        filter: {
          issueId: { kind: 'fk', op: 'in', values: [issueId], labels: [] },
        },
      })
      .then((result) => result.results),
} satisfies AuditDocConfig

const IssueDrawerContext = createContext<OpenIssueDrawer>(() => {})

export function useIssueDrawer(): OpenIssueDrawer {
  return useContext(IssueDrawerContext)
}

/** 提交 mutation:材料/单位由发料清单行锁定带出,后端再快照与折算 */
function itemInput(row: Row) {
  return {
    idx: row.idx,
    orderItemMaterialId: row.orderItemMaterialId,
    qty: row.qty,
    fromWarehouseId: row.fromWarehouseId,
    outsourcedWarehouseId: row.outsourcedWarehouseId,
    remarks: row.remarks ?? null,
  }
}

async function persistItems(
  issueId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  return persistChildRows({
    current,
    snapshot,
    client: purchaseOutsourcedIssueItemClient,
    parentIdField: 'issueId',
    parentId: issueId,
    compareKeys: [
      'idx',
      'orderItemMaterialId',
      'qty',
      'fromWarehouseId',
      'outsourcedWarehouseId',
      'remarks',
    ],
    inputOf: itemInput,
  })
}

/**
 * 外协仓选择器:通过 warehouse REST 按协作方过滤,
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
 * 有效发料清单行固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 已审核委外订单 2. 公司/对手与发料头一致 3. 剩余可发 > 0
 * 使用 REST FilterState，权限与公司/对手/剩余数量条件由服务端白名单解释。
 */
function materialLineGridFilter(values: Record<string, unknown>): FilterState | null {
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
    remainingIssueQty: { kind: 'number', op: 'gt', value: '0' },
  }
}

/** 只读文本字段(材料/单位锁定回显) */
function LockedText({ label, value }: { label: string; value: string }) {
  return (
    <TextField isDisabled value={value || '—'}>
      <Label>{label}</Label>
      <Input />
    </TextField>
  )
}

/**
 * 头关键字段变更清行(ItemsResetGuard)的指纹字段:公司/对手类型/对手任一变则清空条目草稿。
 */
const ITEMS_RESET_FIELDS = ['companyId', 'partyType', 'partyId'] as const

/**
 * 委外发料创建/编辑抽屉(头+条目)。
 * 发料单/发料条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function IssueDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 单据抽屉骨架:双态状态机、URL 身份→明细装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<Row[]>({
    resource: 'purOutsourcedIssues',
    urlSync,
    loadDraft: (issueId) =>
      purchaseOutsourcedIssueItemClient
        .query({
          limit: 200,
          offset: 0,
          sort: { column: 'idx', direction: 'ascending' },
          filter: {
            issueId: { kind: 'fk', op: 'in', values: [issueId], labels: [] },
          },
        })
        .then((result) => result.results),
  })
  const { isOpen, mode, rowId } = drawer
  const issueStatus = drawer.row?.status
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [filters] = useState<FilterState>({})
  // 发料清单行缓存:选择时写入完整行,transformItem 带出快照名
  const linesRef = useRef(new Map<string, Row>())
  const queryClient = useQueryClient()

  const companies = useQuery({
    queryKey: ['purOutsourcedIssues', 'companies'],
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

  // 草稿 → 条目状态派生:draft 变化(含关闭/新建清空为 null)时初始化条目+快照基线并预热清单行缓存
  useEffect(() => {
    const rows = drawer.draft ?? []
    const cache = new Map<string, Row>()
    // 编辑态预热缓存:存量行不必再点选清单行也能过校验/回填(快照即显示源)
    for (const r of rows) {
      if (r.orderItemMaterialId != null) {
        cache.set(String(r.orderItemMaterialId), {
          id: String(r.orderItemMaterialId),
          materialCode: r.materialCode,
          materialName: r.materialName,
          materialSpec: r.materialSpec,
          unitName: r.unitName,
          orderNo: r.orderNo,
        } as Row)
      }
    }
    linesRef.current = cache
    setItems(rows)
    setItemsSnapshot(rows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenIssueDrawer = (nextMode, issue) => {
    drawer.open(nextMode, issue)
  }

  const baseCfg = drawerConfig('purOutsourcedIssues')
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      companyId: {
        ...baseCfg.fields?.companyId,
        defaultValue: createDefaultCompany,
        effects: () => ({ fromWarehouseId: null, outsourcedWarehouseId: null }),
      },
      issueDate: { ...baseCfg.fields?.issueDate, defaultValue: todayLocal() },
      fromWarehouseId: {
        ...baseCfg.fields?.fromWarehouseId,
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
            label="默认调出仓(可空,新建行预填)"
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
            label="默认外协仓(可空,新建行预填)"
          />
        ),
      },
    },
  }

  return (
    <IssueDrawerContext.Provider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="purOutsourcedIssues"
        {...drawerCfg}
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) drawer.close()
        }}
        rowId={rowId}
        onEdit={
          issueStatus === 'DRAFT' ? () => drawer.setMode('edit') : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          const companyId = (values.companyId as string | null) ?? null
          const partyType = (values.partyType as string | null) ?? null
          const partyId = (values.partyId as string | null) ?? null
          const headFromWarehouse = values.fromWarehouseId
          const headOutsourcedWarehouse = values.outsourcedWarehouseId
          const headerReady = Boolean(companyId && partyType && partyId)
          const lineGridFilter = materialLineGridFilter(values)

          // 条目录入:弹窗取发料清单行后锁定回填材料/单位快照;用户只填数量/两仓/备注
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            orderItemMaterialId: {
              order: 0,
              required: true,
              label: '发料清单行',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="purOrderItemMaterials"
                  label="发料清单行"
                  dialogTitle="选择发料清单行"
                  placeholder={lineGridFilter ? '点击选择发料清单行…' : '先选齐公司与对手'}
                  labelField="orderNo"
                  fields={['materialId', 'unitId', 'quantity', 'issuedQty', 'remainingIssueQty']}
                  value={value == null ? null : String(value)}
                  onChange={(id, line) => {
                    void (async () => {
                      // 弹窗表格行缺材料快照名:确认后按 id 补全(材料/单位锁定展示用)
                      let row = line
                      if (id) {
                        try {
                          const full = await purchaseOrderItemMaterialClient.get(id)
                          if (full) {
                            row = {
                              ...full,
                              material: {
                                id: full.materialId,
                                code: full.materialCode,
                                name: full.materialName,
                                spec: full.materialSpec,
                              },
                              unit: { id: full.unitId, name: full.unitName },
                            } as Row
                          }
                        } catch {
                          /* 回填失败时仍写入 id,提交靠后端强制带出兜底 */
                        }
                        if (row) linesRef.current.set(String(id), row)
                      }
                      onChange(id)
                      patchItem({
                        materialCode: row?.materialCode ?? null,
                        materialName: row?.materialName ?? null,
                        materialSpec: row?.materialSpec ?? null,
                        unitName: row?.unitName ?? null,
                        orderNo: row?.orderNo ?? null,
                      })
                    })()
                  }}
                  isDisabled={isDisabled || lineGridFilter == null}
                  isRequired
                  gridFilter={lineGridFilter ?? undefined}
                  gridColumns={[
                    'orderNo',
                    'materialId',
                    'unitId',
                    'quantity',
                    'issuedQty',
                    'remainingIssueQty',
                  ]}
                  gridOverrides={{
                    orderNo: { label: '订单号' },
                    materialId: { label: '材料' },
                    unitId: { label: '单位' },
                    quantity: { label: '清单数量' },
                    issuedQty: { label: '已发料量' },
                    remainingIssueQty: { label: '剩余可发' },
                  }}
                  gridDefaultSort={{ column: 'orderNo', direction: 'ascending' }}
                  gridExtraFields={['materialId', 'unitId']}
                  dialogClassName="max-w-5xl"
                  renderValue={(r) => {
                    const cached = r.id != null ? linesRef.current.get(String(r.id)) : undefined
                    const name = cached?.materialName ?? r.materialName
                    const orderNo = cached?.orderNo ?? r.orderNo
                    return [orderNo, name].filter(Boolean).map(String).join(' ') || '发料清单行'
                  }}
                />
              ),
            },
            // 材料信息只读回显(不进提交手改路径;值由清单行 patch 写入)
            materialName: {
              order: 1,
              label: '材料',
              input: ({ values: iv }) => {
                const code = iv.materialCode != null ? String(iv.materialCode) : ''
                const name = iv.materialName != null ? String(iv.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '选发料清单行后自动带出'
                return <LockedText label="材料" value={text} />
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
            unitName: {
              order: 3,
              cols: 6,
              label: '单位',
              input: ({ values: iv }) => (
                <LockedText
                  label="单位"
                  value={iv.unitName != null ? String(iv.unitName) : '选发料清单行后自动带出'}
                />
              ),
            },
            qty: { order: 4, cols: 6, required: true, label: '发料数量' },
            fromWarehouseId: {
              order: 5,
              required: true,
              label: '调出仓',
              // 新建行默认带出头上「默认调出仓」(用户仍可改)
              defaultValue:
                headFromWarehouse == null || headFromWarehouse === ''
                  ? null
                  : String(headFromWarehouse),
              input: ({ value, onChange, isDisabled }) => (
                <WarehouseRemoteSelect
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  companyId={companyId}
                  label="调出仓"
                />
              ),
            },
            outsourcedWarehouseId: {
              order: 6,
              required: true,
              label: '外协仓',
              // 新建行默认带出头上「默认外协仓」(用户仍可改)
              defaultValue:
                headOutsourcedWarehouse == null || headOutsourcedWarehouse === ''
                  ? null
                  : String(headOutsourcedWarehouse),
              input: ({ value, onChange, isDisabled }) => (
                <OutsourcedWarehouseSelect
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  partyType={partyType}
                  partyId={partyId}
                  label="外协仓"
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
            // 手改材料/单位入口彻底隐藏(后端以清单行为准强制带出)
            materialId: { visible: () => false },
            unitId: { visible: () => false },
            materialCode: { visible: () => false },
            orderNo: { visible: () => false },
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
                key={`${rowId ?? 'create'}-${drawer.generation}`}
                mode={mode}
                row={row}
                values={values}
                fields={ITEMS_RESET_FIELDS}
                onReset={resetItems}
              />
              <SynieEditableTable
                resource="purOutsourcedIssueItems"
                label="发料条目"
                items={items}
                onChange={setItems}
                readOnly={
                  mode === 'view' ||
                  (row != null && row.status !== 'DRAFT') ||
                  (mode !== 'create' && !drawer.detailLoaded)
                }
                canCreate={headerReady}
                toolbar={
                  mode !== 'view' && !headerReady ? (
                    <span className="text-xs text-muted">先选齐公司、对手类型与对手</span>
                  ) : undefined
                }
                drawerClassName="w-full lg:w-[560px]"
                exclude={[
                  'issueId',
                  'companyId',
                  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
                  'issueNo',
                  'issueDate',
                  'issueStatus',
                  'partyType',
                  'partyId',
                ]}
                columns={[
                  'idx',
                  'orderItemMaterialId',
                  'materialName',
                  'unitName',
                  'qty',
                  'fromWarehouseId',
                  'outsourcedWarehouseId',
                  'baseQty',
                  'remarks',
                ]}
                overrides={{
                  orderItemMaterialId: {
                    // 材料另有列,此处只展示订单号
                    label: '订单',
                    render: (_v, r) =>
                      r.orderNo != null && r.orderNo !== '' ? String(r.orderNo) : undefined,
                  },
                  materialName: {
                    label: '材料',
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: (_v, r) => {
                      const code = r.materialCode != null ? String(r.materialCode) : ''
                      const name = r.materialName != null ? String(r.materialName) : ''
                      const title = [code, name].filter(Boolean).join(' ')
                      if (!title && r.materialSpec == null) return undefined
                      const spec =
                        r.materialSpec != null && r.materialSpec !== ''
                          ? String(r.materialSpec)
                          : null
                      return (
                        <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
                          {title ? <span className="truncate font-medium">{title}</span> : null}
                          {spec ? (
                            <span className="truncate text-xs text-muted" title={spec}>
                              规格 {spec}
                            </span>
                          ) : null}
                        </div>
                      )
                    },
                  },
                  unitName: { label: '单位' },
                  fromWarehouseId: { label: '调出仓' },
                  outsourcedWarehouseId: { label: '外协仓' },
                  baseQty: { label: '折算数量' },
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, _items, editing) => {
                  if (!vals.orderItemMaterialId) return '请选择发料清单行'
                  const cached =
                    vals.orderItemMaterialId != null
                      ? linesRef.current.get(String(vals.orderItemMaterialId))
                      : undefined
                  const hasMaterial =
                    cached?.materialName ?? editing?.materialName ?? vals.materialName
                  if (!hasMaterial) return '请重新选择发料清单行以带出材料'
                  if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                  if (!vals.fromWarehouseId) return '请选择调出仓'
                  if (!vals.outsourcedWarehouseId) return '请选择外协仓'
                }}
                transformItem={(vals, editing) => {
                  const line =
                    vals.orderItemMaterialId != null
                      ? linesRef.current.get(String(vals.orderItemMaterialId))
                      : undefined
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    // 新建行预填头默认仓
                    ...(!editing && !vals.fromWarehouseId && headFromWarehouse
                      ? { fromWarehouseId: headFromWarehouse }
                      : {}),
                    ...(!editing && !vals.outsourcedWarehouseId && headOutsourcedWarehouse
                      ? { outsourcedWarehouseId: headOutsourcedWarehouse }
                      : {}),
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
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const saved = await purchaseOutsourcedIssueClient.create(values)
            const issueId = String(saved.id)
            const itemErrors = await persistItems(issueId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('发料单已创建,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('委外发料单已创建')
            }
            savedId = issueId
          } else {
            await purchaseOutsourcedIssueClient.update(rowId!, values)
            const itemErrors = await persistItems(rowId!, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('发料单已更新,但部分条目保存失败', {
                description: itemErrors.join('; '),
              })
            } else {
              toast.success('委外发料单已更新')
            }
            savedId = rowId!
          }
          await Promise.all([
            resourceBindingFor('purOutsourcedIssues').cache.invalidateAll(
              queryClient,
            ),
            resourceBindingFor(
              'purOutsourcedIssueItems',
            ).cache.invalidateGrid(queryClient),
            resourceBindingFor(
              'purOrderItemMaterials',
            ).cache.invalidateGrid(queryClient),
          ])
          return savedId
        }}
      />
    </IssueDrawerContext.Provider>
  )
}
