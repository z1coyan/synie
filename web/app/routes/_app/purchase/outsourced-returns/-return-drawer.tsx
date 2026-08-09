import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Input, Label, NumberField, TextField, toast } from '@heroui/react'
import {
  headerFieldErrors,
  rowErrors,
} from '~/lib/resources/sales-delivery-draft'
import { buildPurchaseOutsourcedReturnDraft, type ReturnDraftIndex } from '~/lib/resources/sales-return-draft'
import { APIError } from '~/lib/api/client'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import type { PurchaseOutsourcedReturnSavedDraft } from '~/lib/resources/returns'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { auditMaterialCell, type AuditDocConfig } from '../../scm/-audit-doc'
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from '../../scm/-stock-doc'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { todayLocal, useAuthorizedCompanies } from '~/lib/form-defaults'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

const purchaseReturnBinding = resourceBindingFor('purOutsourcedReturns')
const purchaseReturnDraft = aggregateDraftFor('purOutsourcedReturns')

export interface ReturnRef {
  id: string
  status?: unknown
}

export type OpenReturnDrawer = (mode: DrawerMode, doc: ReturnRef | null) => void

/**
 * 审核确认弹窗：子记录经完整草稿读取（无分页截断），不走默认 limit 的子资源 query。
 */
async function loadReturnItemsForAudit(returnId: string): Promise<Row[]> {
  return (await purchaseReturnDraft.loadDraft(returnId)).items
}

// 「审核整单」确认弹窗配置:条目页行操作与退货单页「审核」动作共用(见 scm/-audit-doc)
export const returnAuditConfig = {
  docLabel: '委外退货单',
  resource: 'purOutsourcedReturns',
  commandKey: 'audit',
  itemsResource: 'purOutsourcedReturnItems',
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ drawingOwnerType: 'pur_outsourced_return_item' }),
    },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '退货数量', align: 'end' },
    { key: 'baseQty', label: '折算数量', align: 'end' },
    { key: 'remarks', label: '行备注' },
  ],
  loadItems: loadReturnItemsForAudit,
} satisfies AuditDocConfig

const {
  useOpen: useReturnDrawer,
  Provider: ReturnDrawerOpenProvider,
} = createDocumentDrawerOpenBridge<OpenReturnDrawer>()
export { useReturnDrawer }

/**
 * 可退货委外入库条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 委外入库单已审核未作废 2. 公司/对手与退货头一致 3. 剩余可退数量 > 0 4. 已对账数量 = 0
 * 使用 REST FilterState，权限与公司/对手/剩余数量条件由服务端白名单解释。
 */
function outsourcedReceiptItemGridFilter(values: Record<string, unknown>): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  return {
    receiptStatus: { kind: 'enum', values: ['AUDITED'] },
    companyId: { kind: 'fk', op: 'in', values: [String(companyId)], labels: [] },
    partyType: { kind: 'enum', values: [String(partyType)] },
    partyId: {
      kind: 'polyFk',
      op: 'in',
      variant: String(partyType),
      values: [String(partyId)],
      labels: [],
    },
    remainingReturnableQty: { kind: 'number', op: 'gt', value: '0' },
    // 委外定案：已对账数量 > 0 的委外入库条目禁止退货（加工费只对账一次）
    reconciledQty: { kind: 'number', op: 'eq', value: '0' },
  }
}

function outsourcedReceiptItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining = r.remainingReturnableQty != null ? String(r.remainingReturnableQty) : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem = remaining != null ? `可退${remaining}${unit ? unit : ''}` : ''
  return [material || '委外入库条目', rem].filter(Boolean).join(' · ')
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

/** 行形态判别:未挂委外入库条目即手工行(手填物料/价税) */
function isManualItem(vals: Record<string, unknown>): boolean {
  return vals.outsourcedReceiptItemId == null || vals.outsourcedReceiptItemId === ''
}

/**
 * 头关键字段变更清行(ItemsResetGuard)的指纹字段:公司/对手类型/对手任一变则清空条目草稿。
 */
const ITEMS_RESET_FIELDS = ['companyId', 'partyType', 'partyId'] as const

/**
 * 采购退货创建/编辑抽屉(头+条目,单 tab 无装箱)。
 * 退货单/退货条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function ReturnDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 委外入库条目缓存:选择时写入完整行,transformItem 带出快照名
  const outsourcedReceiptItemsRef = useRef(new Map<string, Row>())
  // 手工行物料缓存:选择时写入,transformItem 带出快照名
  const manualMaterialsRef = useRef(new Map<string, Row>())
  const draftHeadRef = useRef<Record<string, unknown>>({})
  // 保存后身份切换占号:acceptSavedDraft 先写缓存再切 recordId,骨架装载直取,不双发 loadDraft
  const savedDraftsRef = useRef(new Map<string, PurchaseOutsourcedReturnSavedDraft>())
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<PurchaseOutsourcedReturnSavedDraft>({
    resource: 'purOutsourcedReturns',
    urlSync,
    loadDraft: (id) => {
      const cached = savedDraftsRef.current.get(id)
      if (cached) {
        savedDraftsRef.current.delete(id)
        return Promise.resolve(cached)
      }
      return purchaseReturnDraft.loadDraft(id)
    },
  })
  const { isOpen, mode, rowId } = drawer
  const [items, setItems] = useState<Row[]>([])
  const [draftErrors, setDraftErrors] = useState<Record<string, string[]>>({})
  const [draftErrorIndex, setDraftErrorIndex] = useState<ReturnDraftIndex | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [filters] = useState<FilterState>({})
  const queryClient = useQueryClient()
  // 编辑入口:权威草稿优先(保存后立即有 status),其次 URL 自查行 / 本地 open 入参
  const returnStatus = drawer.draft?.status ?? drawer.row?.status

  const companies = useAuthorizedCompanies()

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const resetItems = useCallback(() => {
    setDraftErrors({})
    setItems((cur) => (cur.length === 0 ? cur : []))
  }, [])

  // 草稿 → 条目集合派生:draft 变化(含关闭/新建清空为 null)时初始化,
  // 预热委外入库条目缓存并写 draftHeadRef(onSubmit 合并头字段用)
  useEffect(() => {
    const saved = drawer.draft
    draftHeadRef.current = saved ?? {}
    const itemRows = saved?.items ?? []
    // 编辑态预热缓存:存量行不必再点选委外入库条目也能过校验/回填
    const cache = new Map<string, Row>()
    for (const r of itemRows) {
      if (r.outsourcedReceiptItemId != null) {
        cache.set(String(r.outsourcedReceiptItemId), {
          id: String(r.outsourcedReceiptItemId),
          materialId: r.materialId,
          unitId: r.unitId,
          materialCode: r.materialCode,
          materialName: r.materialName,
          materialSpec: r.materialSpec,
          customerPartNo: r.customerPartNo,
          unitName: r.unitName,
          orderNo: r.orderNo,
        } as Row)
      }
    }
    outsourcedReceiptItemsRef.current = cache
    setDraftErrors({})
    setItems(itemRows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenReturnDrawer = (nextMode, doc) => {
    drawer.open(nextMode, doc)
  }

  const acceptSavedDraft = (saved: PurchaseOutsourcedReturnSavedDraft) => {
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
  const baseCfg = drawerConfig('purOutsourcedReturns')
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
        effects: () => ({ warehouseId: null }),
      },
      returnDate: { ...baseCfg.fields?.returnDate, defaultValue: todayLocal() },
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
            label="默认仓库(可空,仅新建行预填)"
          />
        ),
      },
    },
  }

  return (
    <ReturnDrawerOpenProvider value={openDrawer}>
      {children}
      <SynieRecordDrawer
        resource="purReturns"
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
        keepOpenOnAuditFailure
        onEdit={
          returnStatus === 'DRAFT' ? () => drawer.setMode('edit') : undefined
        }
        extraContent={(mode, row, values, patchValues) => {
          draftHeadRef.current = values
          const companyId = (values.companyId as string | null) ?? null
          const headWarehouse = values.warehouseId
          const headerReady = Boolean(values.companyId && values.partyType && values.partyId)
          const diGridFilter = outsourcedReceiptItemGridFilter(values)

          // 条目录入两种方式:「从委外入库单导入」(弹窗选委外入库条目,锁定回填物料/单位快照)
          // 与「手工加行」(不选委外入库条目,手填物料/单位/数量/含税单价/税率)
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            outsourcedReceiptItemId: {
              order: 0,
              section: '方式一:从委外入库单导入(源单行)',
              label: '委外入库条目(留空保存即为手工行)',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="purOutsourcedReceiptItems"
                  label="委外入库条目"
                  dialogTitle="选择可退货委外入库条目"
                  placeholder={
                    diGridFilter ? '点击选择委外入库条目;留空则按下方手工填写建行…' : '先选齐公司与对手'
                  }
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
                    'returnedQty',
                    'remainingReturnableQty',
                    'receiptDate',
                    'receiptNo',
                    'orderNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, ditem) => {
                    if (id && ditem) outsourcedReceiptItemsRef.current.set(String(id), ditem)
                    onChange(id)
                    // 物料/单位随委外入库条目锁定带出;collectValues 会丢 hidden 字段,
                    // 真正落行靠 transformItem 读 outsourcedReceiptItemsRef
                    patchItem({
                      materialId: ditem?.materialId ?? null,
                      unitId: ditem?.unitId ?? null,
                      materialCode: ditem?.materialCode ?? null,
                      materialName: ditem?.materialName ?? null,
                      materialSpec: ditem?.materialSpec ?? null,
                      customerPartNo: ditem?.customerPartNo ?? null,
                      unitName: ditem?.unitName ?? null,
                      orderNo: ditem?.orderNo ?? null,
                    })
                  }}
                  isDisabled={isDisabled || diGridFilter == null}
                  gridFilter={diGridFilter ?? undefined}
                  gridColumns={[
                    'receiptDate',
                    'receiptNo',
                    'orderNo',
                    'materialCode',
                    'materialName',
                    'materialSpec',
                    'customerPartNo',
                    'unitName',
                    'baseQty',
                    'returnedQty',
                    'remainingReturnableQty',
                  ]}
                  gridOverrides={{
                    receiptDate: { label: '委外入库日期' },
                    receiptNo: { label: '委外委外入库单号' },
                    orderNo: { label: '订单号' },
                    materialCode: { label: '物料编号' },
                    materialName: { label: '物料名称' },
                    materialSpec: { label: '规格' },
                    customerPartNo: { label: '客户料号' },
                    unitName: { label: '单位' },
                    baseQty: { label: '委外入库数量' },
                    returnedQty: { label: '已退数量' },
                    remainingReturnableQty: { label: '剩余可退' },
                  }}
                  gridDefaultSort={{ column: 'receiptDate', direction: 'descending' }}
                  gridExtraFields={['materialId', 'unitId']}
                  dialogClassName="max-w-5xl"
                  renderValue={(r) => outsourcedReceiptItemDisplay(r)}
                />
              ),
            },
            // 手工行字段组(未挂委外入库条目时可见):物料/单位/含税单价/税率手填
            materialId: {
              order: 1,
              section: '方式二:手工加行(无源单历史退货)',
              label: '物料',
              required: true,
              visible: (v) => isManualItem(v),
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="invMaterials"
                  label="物料"
                  dialogTitle="选择物料"
                  placeholder="点击选择物料…"
                  labelField="name"
                  fields={['code', 'name', 'spec', 'customerPartNo', 'defaultUnitId']}
                  value={value == null ? null : String(value)}
                  onChange={(id, material) => {
                    if (id && material) manualMaterialsRef.current.set(String(id), material)
                    onChange(id)
                    patchItem({
                      materialCode: material?.code ?? null,
                      materialName: material?.name ?? null,
                      materialSpec: material?.spec ?? null,
                      customerPartNo: material?.customerPartNo ?? null,
                      // 换物料重置单位(MaterialUnitSelect 会带出新默认单位)
                      unitId: null,
                      unitName: null,
                    })
                  }}
                  isDisabled={isDisabled}
                  isRequired
                  gridColumns={['code', 'name', 'spec', 'customerPartNo']}
                  gridOverrides={{
                    code: { label: '物料编号' },
                    name: { label: '物料名称' },
                    spec: { label: '规格' },
                    customerPartNo: { label: '客户料号' },
                  }}
                  gridFilter={{ active: { kind: 'bool', eq: true } }}
                  dialogClassName="max-w-3xl"
                  renderValue={(r) =>
                    [r.materialCode ?? r.code, r.materialName ?? r.name]
                      .filter((x) => x != null && x !== '')
                      .join(' ') || '物料'
                  }
                />
              ),
            },
            unitId: {
              order: 2,
              cols: 6,
              required: true,
              label: '单位',
              visible: (v) => isManualItem(v),
              input: ({ value, onChange, isDisabled, values: lv }) => (
                <MaterialUnitSelect
                  materialId={lv.materialId == null ? null : String(lv.materialId)}
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                />
              ),
            },
            // 物料信息只读回显(源单行;不进提交手改路径;值由委外入库条目 patch 写入)
            materialName: {
              order: 1,
              label: '物料',
              visible: (v) => !isManualItem(v),
              input: ({ values: iv }) => {
                const code = iv.materialCode != null ? String(iv.materialCode) : ''
                const name = iv.materialName != null ? String(iv.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '选委外入库条目后自动带出'
                return <LockedText label="物料" value={text} />
              },
            },
            materialSpec: {
              order: 2,
              cols: 6,
              label: '规格',
              visible: (v) => !isManualItem(v),
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
              visible: (v) => !isManualItem(v),
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
              visible: (v) => !isManualItem(v),
              input: ({ values: iv }) => (
                <LockedText
                  label="单位"
                  value={iv.unitName != null ? String(iv.unitName) : '选委外入库条目后自动带出'}
                />
              ),
            },
            qty: { order: 5, cols: 6, required: true, label: '退货数量' },
            warehouseId: {
              order: 6,
              required: true,
              label: '退货出仓',
              // 新建行默认带出头上「默认仓库」(用户仍可改)
              defaultValue:
                headWarehouse == null || headWarehouse === '' ? null : String(headWarehouse),
              input: ({ value, onChange, isDisabled }) => (
                <WarehouseRemoteSelect
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  companyId={companyId}
                  label="退货出仓"
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
            // 快照载波不进表单(值随委外入库条目/物料选择写入草稿行)
            materialCode: { visible: () => false },
            orderItemId: { visible: () => false },
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
                resource="purOutsourcedReturnItems"
                label="退货条目"
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
                  ) : undefined
                }
                drawerClassName="w-full lg:w-[560px]"
                exclude={[
                  'returnId',
                  'companyId',
                  // 头字段 calculation 只服务条目 tab 跨单列表,绝不进行级表单
                  'returnNo',
                  'returnDate',
                  'returnStatus',
                  'partyType',
                  'partyId',
                  // 订单数量快照不进表单(物料/单位快照名走只读字段展示)
                  'orderQty',
                  'orderBaseQty',
                  'orderUnitName',
                  'orderNo',
                ]}
                columns={[
                  'idx',
                  'outsourcedReceiptItemId',
                  'materialName',
                  'unitName',
                  'qty',
                  'warehouseId',
                  'baseQty',
                  'remarks',
                ]}
                overrides={{
                  outsourcedReceiptItemId: {
                    // 物料另有列,此处只展示订单号;手工行无源单
                    label: '来源订单',
                    render: (_v, r) =>
                      r.orderNo != null && r.orderNo !== ''
                        ? String(r.orderNo)
                        : r.outsourcedReceiptItemId == null || r.outsourcedReceiptItemId === ''
                          ? '手工行'
                          : undefined,
                  },
                  // 物料列:全站统一富单元格(图纸缩略图+快照四字段);行图纸挂接优先
                  materialName: {
                    label: '物料',
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: materialCellRender({ drawingOwnerType: 'pur_outsourced_return_item' }),
                  },
                  unitName: { label: '单位' },
                  baseQty: { label: '折算数量' },
                  remarks: { label: '行备注' },
                }}
                fields={itemFields}
                validateItem={(vals, _items, editing) => {
                  if (isManualItem(vals)) {
                    // 手工行:物料/单位/价税手填
                    if (!vals.materialId) return '请选择物料'
                    if (!vals.unitId) return '请选择单位'
                  } else {
                    // materialId 是表单条件字段,源单行模式下被剥离——用缓存/编辑行判定
                    const cached = outsourcedReceiptItemsRef.current.get(String(vals.outsourcedReceiptItemId))
                    const materialId =
                      cached?.materialId ?? editing?.materialId ?? vals.materialId
                    const unitId = cached?.unitId ?? editing?.unitId ?? vals.unitId
                    if (!materialId || !unitId) return '请重新选择委外入库条目以带出物料'
                  }
                  if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                  // 行仓不再前端硬卡:虚拟行不入仓可空;库存类行缺仓由后端保存校验兜底
                }}
                transformItem={(vals, editing) => {
                  const manual = isManualItem(vals)
                  const ditem = manual
                    ? undefined
                    : outsourcedReceiptItemsRef.current.get(String(vals.outsourcedReceiptItemId))
                  const material = manual
                    ? (manualMaterialsRef.current.get(String(vals.materialId)) ?? undefined)
                    : undefined
                  // 条件字段在另一模式下被剥离:物料/单位以缓存或编辑行补全
                  const materialId = manual
                    ? (vals.materialId ?? editing?.materialId)
                    : (ditem?.materialId ?? editing?.materialId ?? vals.materialId)
                  const unitId = manual
                    ? (vals.unitId ?? editing?.unitId)
                    : (ditem?.unitId ?? editing?.unitId ?? vals.unitId)
                  return {
                    ...vals,
                    idx: editing
                      ? editing.idx
                      : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                    outsourcedReceiptItemId: manual ? null : vals.outsourcedReceiptItemId,
                    // 新建行预填头默认仓
                    ...(!editing && !vals.warehouseId && headWarehouse
                      ? { warehouseId: headWarehouse }
                      : {}),
                    materialId,
                    unitId,
                    materialCode:
                      (manual ? material?.code : ditem?.materialCode) ??
                      editing?.materialCode ??
                      vals.materialCode ??
                      null,
                    materialName:
                      (manual ? material?.name : ditem?.materialName) ??
                      editing?.materialName ??
                      vals.materialName ??
                      null,
                    materialSpec:
                      (manual ? material?.spec : ditem?.materialSpec) ??
                      editing?.materialSpec ??
                      vals.materialSpec ??
                      null,
                    customerPartNo:
                      (manual ? material?.customerPartNo : ditem?.customerPartNo) ??
                      editing?.customerPartNo ??
                      vals.customerPartNo ??
                      null,
                    unitName: manual
                      ? (editing?.unitName ?? vals.unitName ?? null)
                      : (ditem?.unitName ?? editing?.unitName ?? vals.unitName ?? null),
                    orderNo: manual
                      ? null
                      : (ditem?.orderNo ?? editing?.orderNo ?? vals.orderNo ?? null),
                  }
                }}
              />
            </>
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          assertAggregateDraftReady(mode, drawer.detailLoaded, '退货明细')
          // 表单只经 AggregateDraftAdapter；binding 不挂 create/update writer
          const writerBag = purchaseReturnBinding.writer as
            | Partial<{ create: unknown; update: unknown }>
            | undefined
          if (writerBag?.create || writerBag?.update) {
            throw new Error('委外退货表单不得暴露 RecordWriter create/update')
          }
          const request = buildPurchaseOutsourcedReturnDraft(
            { ...draftHeadRef.current, ...values },
            items,
          )
          setDraftErrors({})
          setDraftErrorIndex(request.index)
          setSubmitting(true)
          try {
            const saved =
              mode === 'create'
                ? await purchaseReturnDraft.createDraft(request.draft)
                : await purchaseReturnDraft.replaceDraft(
                    rowId!,
                    request.draft,
                  )
            acceptSavedDraft(saved)
            queryClient.setQueryData(
              purchaseReturnBinding.cache.rowKey(String(saved.id)),
              saved,
            )
            await Promise.all([
              purchaseReturnBinding.cache.invalidateGrid(queryClient),
              resourceBindingFor('purOutsourcedReturnItems').cache.invalidateGrid(
                queryClient,
              ),
              resourceBindingFor('purOutsourcedReceiptItems').cache.invalidateGrid(
                queryClient,
              ),
              resourceBindingFor('purOrderItems').cache.invalidateGrid(
                queryClient,
              ),
            ])
            toast.success(`委外退货单已${mode === 'create' ? '创建' : '更新'}`)
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
    </ReturnDrawerOpenProvider>
  )
}
