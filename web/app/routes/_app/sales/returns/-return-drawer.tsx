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
import { buildReturnDraft, type ReturnDraftIndex } from '~/lib/resources/sales-return-draft'
import { APIError } from '~/lib/api/client'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import type { SalesReturnSavedDraft } from '~/lib/resources/returns'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
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
import { fetchCompanyAccountDefaults } from '~/components/company-account-defaults'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { todayLocal, useAuthorizedCompanies } from '~/lib/form-defaults'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

const salesReturnBinding = resourceBindingFor('salReturns')
const salesReturnDraft = aggregateDraftFor('salReturns')

export interface ReturnRef {
  id: string
  status?: unknown
}

export type OpenReturnDrawer = (mode: DrawerMode, doc: ReturnRef | null) => void

/**
 * 审核确认弹窗：子记录经完整草稿读取（无分页截断），不走默认 limit 的子资源 query。
 */
async function loadReturnItemsForAudit(returnId: string): Promise<Row[]> {
  return (await salesReturnDraft.loadDraft(returnId)).items
}

// 「审核整单」确认弹窗配置:条目页行操作与退货单页「审核」动作共用(见 scm/-audit-doc)
export const returnAuditConfig = {
  docLabel: '销售退货单',
  resource: 'salReturns',
  commandKey: 'audit',
  itemsResource: 'salReturnItems',
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ drawingOwnerType: 'sal_return_item' }),
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
 * 新建态:公司选定/变更时整组覆盖借贷科目为该公司默认(发货槽反转代入,同销售对账先例;
 * 无默认则清空)。编辑态公司锁死,不重灌。
 */
function ReturnAccountDefaultSync({
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
        // 退货 = 发货反转:借方代入发货贷方槽,贷方(未开票应收)代入发货借方槽
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

function ReturnAccountFooter({
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
        {fieldErrors?.debitAccountId?.length ? (
          <p className="mt-1 text-xs text-danger" role="alert">
            {fieldErrors.debitAccountId.join('；')}
          </p>
        ) : null}
      </div>
      <div>
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
 * 可退货发货条目固定筛选(弹窗 SynieDataGrid fixedFilter):
 * 1. 发货单已审核未作废 2. 公司/对手与退货头一致 3. 剩余可退数量 > 0
 * 使用 REST FilterState，权限与公司/对手/剩余数量条件由服务端白名单解释。
 */
function deliveryItemGridFilter(values: Record<string, unknown>): FilterState | null {
  const { companyId, partyType, partyId } = values
  if (!companyId || !partyType || !partyId) return null
  return {
    deliveryStatus: { kind: 'enum', values: ['AUDITED'] },
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
  }
}

function deliveryItemDisplay(r: Row): string {
  const code = r.materialCode != null ? String(r.materialCode) : ''
  const name = r.materialName != null ? String(r.materialName) : ''
  const material = [code, name].filter(Boolean).join(' ')
  const remaining = r.remainingReturnableQty != null ? String(r.remainingReturnableQty) : null
  const unit = r.unitName != null ? String(r.unitName) : ''
  const rem = remaining != null ? `可退${remaining}${unit ? unit : ''}` : ''
  return [material || '发货条目', rem].filter(Boolean).join(' · ')
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
 * 新建态:公司选定后按公司本币代入原币与汇率 1(含手工行时的全单换算口径)。
 * 编辑态公司锁死,不重灌。
 */
function ReturnCurrencyDefaultSync({
  mode,
  companyId,
  currencyId,
  companies,
  patchValues,
}: {
  mode: DrawerMode
  companyId: string | null
  currencyId: string | null
  companies: Row[]
  patchValues: (patch: Record<string, unknown>) => void
}) {
  useEffect(() => {
    if (mode !== 'create' || !companyId || currencyId) return
    const company = companies.find((c) => String(c.id) === companyId)
    const base = company?.baseCurrencyId
    if (base != null && base !== '') {
      patchValues({ currencyId: String(base), exchangeRate: '1' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, companyId, currencyId, companies])
  return null
}

/** 行形态判别:未挂发货条目即手工行(手填物料/价税) */
function isManualItem(vals: Record<string, unknown>): boolean {
  return vals.deliveryItemId == null || vals.deliveryItemId === ''
}

/**
 * 头关键字段变更清行(ItemsResetGuard)的指纹字段:公司/对手类型/对手任一变则清空条目草稿。
 */
const ITEMS_RESET_FIELDS = ['companyId', 'partyType', 'partyId'] as const

/**
 * 销售退货创建/编辑抽屉(头+条目,单 tab 无装箱)。
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
  // 发货条目缓存:选择时写入完整行,transformItem 带出快照名
  const deliveryItemsRef = useRef(new Map<string, Row>())
  // 手工行物料缓存:选择时写入,transformItem 带出快照名
  const manualMaterialsRef = useRef(new Map<string, Row>())
  const draftHeadRef = useRef<Record<string, unknown>>({})
  // 保存后身份切换占号:acceptSavedDraft 先写缓存再切 recordId,骨架装载直取,不双发 loadDraft
  const savedDraftsRef = useRef(new Map<string, SalesReturnSavedDraft>())
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<SalesReturnSavedDraft>({
    resource: 'salReturns',
    urlSync,
    loadDraft: (id) => {
      const cached = savedDraftsRef.current.get(id)
      if (cached) {
        savedDraftsRef.current.delete(id)
        return Promise.resolve(cached)
      }
      return salesReturnDraft.loadDraft(id)
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
  // 预热发货条目缓存并写 draftHeadRef(onSubmit 合并头字段用)
  useEffect(() => {
    const saved = drawer.draft
    draftHeadRef.current = saved ?? {}
    const itemRows = saved?.items ?? []
    // 编辑态预热缓存:存量行不必再点选发货条目也能过校验/回填
    const cache = new Map<string, Row>()
    for (const r of itemRows) {
      if (r.deliveryItemId != null) {
        cache.set(String(r.deliveryItemId), {
          id: String(r.deliveryItemId),
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
    deliveryItemsRef.current = cache
    setDraftErrors({})
    setItems(itemRows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenReturnDrawer = (nextMode, doc) => {
    drawer.open(nextMode, doc)
  }

  const acceptSavedDraft = (saved: SalesReturnSavedDraft) => {
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
  const baseCfg = drawerConfig('salReturns')
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
      returnDate: { ...baseCfg.fields?.returnDate, defaultValue: todayLocal() },
      // 原币:新建按公司本币代入(ReturnCurrencyDefaultSync);有行后锁改(后端同规)
      currencyId: {
        ...baseCfg.fields?.currencyId,
        input: ({
          value,
          onChange,
          isDisabled,
        }: {
          value: unknown
          onChange: (v: unknown) => void
          isDisabled: boolean
        }) => (
          <RemoteSelect
            resource="basCurrencies"
            label="原币(含手工行时全单换算口径;有行后锁改)"
            value={value == null || value === '' ? null : String(value)}
            onChange={onChange}
            isDisabled={isDisabled || items.length > 0}
            filterState={{ active: { kind: 'bool', eq: true } }}
            labelField="name"
            searchFields={['name', 'isoCode']}
            itemSubtitleFields={['isoCode']}
          />
        ),
      },
      exchangeRate: { ...baseCfg.fields?.exchangeRate, defaultValue: '1' },
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
        resource="salReturns"
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
          const diGridFilter = deliveryItemGridFilter(values)

          // 条目录入两种方式:「从发货单导入」(弹窗选发货条目,锁定回填物料/单位快照)
          // 与「手工加行」(不选发货条目,手填物料/单位/数量/含税单价/税率)
          const itemFields: Record<string, FieldOverride> = {
            idx: { visible: () => false },
            deliveryItemId: {
              order: 0,
              section: '方式一:从发货单导入(源单行)',
              label: '发货条目(留空保存即为手工行)',
              input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                <RemoteDialogSelect
                  resource="salDeliveryItems"
                  label="发货条目"
                  dialogTitle="选择可退货发货条目"
                  placeholder={
                    diGridFilter ? '点击选择发货条目;留空则按下方手工填写建行…' : '先选齐公司与对手'
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
                    'deliveryDate',
                    'deliveryNo',
                    'orderNo',
                  ]}
                  value={value == null ? null : String(value)}
                  onChange={(id, ditem) => {
                    if (id && ditem) deliveryItemsRef.current.set(String(id), ditem)
                    onChange(id)
                    // 物料/单位随发货条目锁定带出;collectValues 会丢 hidden 字段,
                    // 真正落行靠 transformItem 读 deliveryItemsRef
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
                    'deliveryDate',
                    'deliveryNo',
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
                    deliveryDate: { label: '发货日期' },
                    deliveryNo: { label: '发货单号' },
                    orderNo: { label: '订单号' },
                    materialCode: { label: '物料编号' },
                    materialName: { label: '物料名称' },
                    materialSpec: { label: '规格' },
                    customerPartNo: { label: '客户料号' },
                    unitName: { label: '单位' },
                    baseQty: { label: '发货数量' },
                    returnedQty: { label: '已退数量' },
                    remainingReturnableQty: { label: '剩余可退' },
                  }}
                  gridDefaultSort={{ column: 'deliveryDate', direction: 'descending' }}
                  gridExtraFields={['materialId', 'unitId']}
                  dialogClassName="max-w-5xl"
                  renderValue={(r) => deliveryItemDisplay(r)}
                />
              ),
            },
            // 手工行字段组(未挂发货条目时可见):物料/单位/含税单价/税率手填
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
            orderPrice: {
              order: 3,
              cols: 6,
              required: true,
              label: '含税单价(原币)',
              visible: (v) => isManualItem(v),
            },
            orderTaxRate: {
              order: 4,
              cols: 6,
              required: true,
              label: '税率',
              visible: (v) => isManualItem(v),
            },
            // 物料信息只读回显(源单行;不进提交手改路径;值由发货条目 patch 写入)
            materialName: {
              order: 1,
              label: '物料',
              visible: (v) => !isManualItem(v),
              input: ({ values: iv }) => {
                const code = iv.materialCode != null ? String(iv.materialCode) : ''
                const name = iv.materialName != null ? String(iv.materialName) : ''
                const text = [code, name].filter(Boolean).join(' ') || '选发货条目后自动带出'
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
                  value={iv.unitName != null ? String(iv.unitName) : '选发货条目后自动带出'}
                />
              ),
            },
            qty: { order: 5, cols: 6, required: true, label: '退货数量' },
            warehouseId: {
              order: 6,
              required: true,
              label: '退货入仓',
              // 新建行默认带出头上「默认仓库」(用户仍可改)
              defaultValue:
                headWarehouse == null || headWarehouse === '' ? null : String(headWarehouse),
              input: ({ value, onChange, isDisabled }) => (
                <WarehouseRemoteSelect
                  value={value}
                  onChange={onChange}
                  isDisabled={isDisabled}
                  companyId={companyId}
                  label="退货入仓"
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
            // 快照载波不进表单(值随发货条目/物料选择写入草稿行)
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
              <ReturnAccountDefaultSync
                key={`acct-${rowId ?? 'create'}-${drawer.generation}`}
                mode={mode}
                companyId={companyId}
                patchValues={patchValues}
              />
              <ReturnCurrencyDefaultSync
                mode={mode}
                companyId={companyId}
                currencyId={(values.currencyId as string | null) ?? null}
                companies={companies.data ?? []}
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
                resource="salReturnItems"
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
                  // 订单快照不进表单(物料/单位快照名走只读字段展示;价税对手工行是录入字段)
                  'orderQty',
                  'orderBaseQty',
                  'orderUnitName',
                  'orderAmount',
                  'orderBasePrice',
                  'orderBaseAmount',
                  'orderCurrencyCode',
                  'orderNo',
                  'reconciledQty',
                  'remainingReconcilableQty',
                ]}
                columns={[
                  'idx',
                  'deliveryItemId',
                  'materialName',
                  'unitName',
                  'qty',
                  'orderPrice',
                  'orderTaxRate',
                  'warehouseId',
                  'baseQty',
                  'remarks',
                ]}
                overrides={{
                  deliveryItemId: {
                    // 物料另有列,此处只展示订单号;手工行无源单
                    label: '来源订单',
                    render: (_v, r) =>
                      r.orderNo != null && r.orderNo !== ''
                        ? String(r.orderNo)
                        : r.deliveryItemId == null || r.deliveryItemId === ''
                          ? '手工行'
                          : undefined,
                  },
                  orderPrice: { label: '含税单价' },
                  orderTaxRate: { label: '税率' },
                  // 物料列:全站统一富单元格(图纸缩略图+快照四字段);行图纸挂接优先
                  materialName: {
                    label: '物料',
                    className: 'min-w-[12rem] max-w-[18rem]',
                    render: materialCellRender({ drawingOwnerType: 'sal_return_item' }),
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
                    if (vals.orderPrice == null || vals.orderPrice === '') return '请填写含税单价'
                    if (Number(vals.orderPrice) < 0) return '含税单价不能小于 0'
                    if (vals.orderTaxRate == null || vals.orderTaxRate === '') return '请填写税率'
                    if (Number(vals.orderTaxRate) < 0) return '税率不能小于 0'
                  } else {
                    // materialId 是表单条件字段,源单行模式下被剥离——用缓存/编辑行判定
                    const cached = deliveryItemsRef.current.get(String(vals.deliveryItemId))
                    const materialId =
                      cached?.materialId ?? editing?.materialId ?? vals.materialId
                    const unitId = cached?.unitId ?? editing?.unitId ?? vals.unitId
                    if (!materialId || !unitId) return '请重新选择发货条目以带出物料'
                  }
                  if (!(Number(vals.qty) > 0)) return '数量必须大于零'
                  // 行仓不再前端硬卡:虚拟行不入仓可空;库存类行缺仓由后端保存校验兜底
                }}
                transformItem={(vals, editing) => {
                  const manual = isManualItem(vals)
                  const ditem = manual
                    ? undefined
                    : deliveryItemsRef.current.get(String(vals.deliveryItemId))
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
                    deliveryItemId: manual ? null : vals.deliveryItemId,
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
              <ReturnAccountFooter
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
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          assertAggregateDraftReady(mode, drawer.detailLoaded, '退货明细')
          // 表单只经 AggregateDraftAdapter；binding 不挂 create/update writer
          const writerBag = salesReturnBinding.writer as
            | Partial<{ create: unknown; update: unknown }>
            | undefined
          if (writerBag?.create || writerBag?.update) {
            throw new Error('销售退货表单不得暴露 RecordWriter create/update')
          }
          const request = buildReturnDraft(
            { ...draftHeadRef.current, ...values },
            items,
          )
          setDraftErrors({})
          setDraftErrorIndex(request.index)
          setSubmitting(true)
          try {
            const saved =
              mode === 'create'
                ? await salesReturnDraft.createDraft(request.draft)
                : await salesReturnDraft.replaceDraft(
                    rowId!,
                    request.draft,
                  )
            acceptSavedDraft(saved)
            queryClient.setQueryData(
              salesReturnBinding.cache.rowKey(String(saved.id)),
              saved,
            )
            await Promise.all([
              salesReturnBinding.cache.invalidateGrid(queryClient),
              resourceBindingFor('salReturnItems').cache.invalidateGrid(
                queryClient,
              ),
              resourceBindingFor('salDeliveryItems').cache.invalidateGrid(
                queryClient,
              ),
              resourceBindingFor('salOrderItems').cache.invalidateGrid(
                queryClient,
              ),
            ])
            toast.success(`销售退货单已${mode === 'create' ? '创建' : '更新'}`)
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
