import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, TextArea, TextField, toast } from '@heroui/react'
import { formatPrice } from '~/lib/amount'
import { companyClient } from '~/lib/resources/companies'
import { salesQuotationItemClient } from '~/lib/resources/quotations'
import {
  buildQuotationDraft,
  type QuotationSavedDraft,
} from '~/lib/resources/quotation-draft'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { auditMaterialCell, type AuditDocConfig } from '../../scm/-audit-doc'
import { todayLocal } from '~/lib/form-defaults'
import { useDocumentDrawer } from '~/lib/use-document-drawer'

const salesQuotationBinding = resourceBindingFor('salQuotations')
const salesQuotationItemBinding = resourceBindingFor('salQuotationItems')
const salesQuotationTierBinding = resourceBindingFor('salQuotationTiers')
const salesQuotationDraft = aggregateDraftFor('salQuotations')

// 条目表物料列渲染器(模块级常量,避免逐单元格重建);报价条目无图纸挂接,缩略图回退物料当前图纸
const quotationItemMaterialCell = materialCellRender()

/**
 * 销售报价单共享抽屉:布局层挂载一份,报价单 tab(整单 grid)与报价条目 tab(行级 grid)
 * 经 context 调起同一个三态抽屉。三层录入:报价抽屉 → 条目表(SynieEditableTable)→
 * 条目二级抽屉内嵌价格档子表(extraContent 透传,数量梯度条目专用)。
 * 价格档草稿由本页自持(collectValues 会剥离非字段键,不能塞进抽屉草稿),
 * 提交时由报价 Aggregate Draft module 收口整单 wire 与原子替换。
 */

/** 开抽屉需要的最小报价单形状:报价单 tab 传 grid 行;条目 tab 传 {id, status} */
export interface QuotationRef {
  id: string
  /** 决定 view 态是否给「编辑」入口(DRAFT 才给);grid Row 是索引签名类型,故声明为可选 */
  status?: unknown
}

export type OpenQuotationDrawer = (mode: DrawerMode, quotation: QuotationRef | null) => void

const QuotationDrawerContext = createContext<OpenQuotationDrawer>(() => {})

/** 子路由(报价单/报价条目)取 openDrawer:view/edit 传 {id, status},create 传 null */
export function useQuotationDrawer(): OpenQuotationDrawer {
  return useContext(QuotationDrawerContext)
}

function rowTiers(row: Row): Row[] {
  return (row.tiers as Row[] | undefined) ?? []
}

// 税率库存小数(0.13),前端一律按百分比展示/录入
const formatPercent = (v: unknown) => (v == null || v === '' ? '' : `${Math.round(Number(v) * 10000) / 100}%`)

// 起订量 decimal 串去尾零展示(1000.0 → 1000)
const formatQty = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : String(v ?? '')
}

/** 梯度概要:按起订量升序拼「≥量 价」;条目表价格列上固定价显价、梯度显阶梯 */
export function tierSummary(tiers: Row[]): string {
  return [...tiers]
    .sort((a, b) => Number(a.minQty) - Number(b.minQty))
    .map((t) => `≥${formatQty(t.minQty)} ${formatPrice(t.price)}`)
    .join(' / ')
}

// 「审核整单」确认弹窗配置:条目页行操作与报价单页「审核」动作共用(见 scm/-audit-doc)。
// 价格档是独立资源、确认弹窗只查条目,梯度行以档数提示,阶梯明细仍需进抽屉核对
export const salesQuotationAuditConfig = {
  docLabel: '销售报价单',
  resource: 'salQuotations',
  commandKey: 'audit',
  itemsResource: 'salQuotationItems',
  loadItems: (quotationId: string) =>
    salesQuotationItemClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        fixedFilter: {
          quotationId: { kind: 'fk', op: 'in', values: [quotationId], labels: [] },
        },
      })
      .then((result) => result.results),
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell(),
    },
    { key: 'unitName', label: '单位' },
    {
      key: 'pricingMode',
      label: '定价模式',
      render: (v) => (v === 'QTY_TIERED' ? '数量梯度' : v === 'FIXED' ? '固定价' : undefined),
    },
    {
      key: 'price',
      label: '含税单价',
      align: 'end',
      render: (v, r) =>
        r.pricingMode === 'QTY_TIERED' ? `${String(r.tierCount ?? 0)} 档` : formatPrice(v),
    },
    { key: 'taxRate', label: '税率', align: 'end', render: formatPercent },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

/**
 * 公司本币默认币种(渲染为 null 的表单伴生组件):create/edit 态币种为空时
 * (新建初始、切公司被 effects 清空)默认公司本币;已有值不覆盖。
 * 报价单无汇率/双币,不需要订单抽屉那套外币联动。
 */
function CompanyCurrencyDefault({
  mode,
  row,
  values,
  patchValues,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
}) {
  const companyId = String((mode === 'view' ? row?.companyId : (values.companyId ?? row?.companyId)) ?? '')
  const query = useQuery({
    queryKey: ['companyBaseCurrency', companyId],
    enabled: companyId !== '',
    staleTime: 300_000,
    queryFn: () => companyClient.get(companyId).then((company) => company?.baseCurrencyId ?? null),
  })
  const base = companyId === '' ? null : (query.data ?? null)

  const currencyId = values.currencyId
  useEffect(() => {
    if (mode === 'view' || base == null) return
    if (currencyId == null || currencyId === '') patchValues({ currencyId: base })
    // patchValues 每次渲染重建,依赖它会空转;补丁条件由 base/currencyId 驱动,patch 后条件即不满足
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, base, currencyId])

  return null
}

/**
 * 价格档子表(条目二级抽屉的 extraContent):档草稿由 provider 自持,
 * 挂载时以行上已存的档为初值——条目抽屉关闭即卸载,每次打开都重新挂载,
 * 上一次取消编辑的残稿不会泄漏到下一次。
 */
function TierEditor({
  row,
  tiers,
  onChange,
  initFrom,
}: {
  row: Row | null | undefined
  tiers: Row[]
  onChange: (t: Row[]) => void
  initFrom: (row: Row | null | undefined) => void
}) {
  useEffect(() => {
    initFrom(row)
    // 仅挂载时初始化一次(依赖 row 会在父抽屉重渲染时把在编的档打回原值)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <SynieEditableTable
      resource="salQuotationTiers"
      label="价格档"
      items={tiers}
      onChange={onChange}
      exclude={['itemId', 'companyId']}
      columns={['minQty', 'price']}
      overrides={{
        minQty: { label: '起订量', render: (v) => formatQty(v) },
        price: { label: '含税档价', render: (v) => formatPrice(v) },
      }}
      fields={{
        minQty: { order: 0, cols: 6, required: true, label: '起订量', placeholder: '≥ 该量适用本档价' },
        price: { order: 1, cols: 6, required: true, label: '含税档价' },
      }}
      validateItem={(vals, current, editing) => {
        if (!(Number(vals.minQty) > 0)) return '起订量必须大于零'
        if (!(Number(vals.price) >= 0)) return '含税档价不能为负'
        if (current.some((t) => t.id !== editing?.id && Number(t.minQty) === Number(vals.minQty)))
          return '同一起订量档已存在'
      }}
    />
  )
}

/**
 * 销售报价创建/编辑抽屉(头+条目+条款)。
 * 报价单/报价条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function QuotationDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<QuotationSavedDraft>({
    resource: 'salQuotations',
    urlSync,
    loadDraft: (id) => salesQuotationDraft.loadDraft(id),
  })
  const { isOpen, mode, rowId } = drawer
  const quotationStatus = drawer.row?.status
  const [items, setItems] = useState<Row[]>([])
  // 报价条款不走抽屉字段(要排在条目表之下,抽屉 extraContent 固定在字段后渲染),由页面自持
  const [terms, setTerms] = useState('')
  // 条目二级抽屉在编条目的价格档草稿(collectValues 剥离非字段键,不能进抽屉 values)
  const [tierDraft, setTierDraft] = useState<Row[]>([])
  const queryClient = useQueryClient()
  const draftHeadRef = useRef<Row | null>(null)

  // 草稿 → 条目/条款状态派生:draft 变化(含关闭/新建清空为 null)时初始化集合并写 draftHeadRef
  useEffect(() => {
    draftHeadRef.current = drawer.draft
    setTerms(String(drawer.draft?.terms ?? ''))
    setItems(drawer.draft?.items ?? [])
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  const openDrawer: OpenQuotationDrawer = (nextMode, quotation) => {
    drawer.open(nextMode, quotation)
  }

  // 抽屉配置:registry 一份;terms 从字段排除(改由 extraContent 底部渲染,提交时并入 values)
  const baseCfg = drawerConfig('salQuotations')
  const drawerCfg = {
    ...baseCfg,
    exclude: [...(baseCfg.exclude ?? []), 'terms'],
    fields: {
      ...baseCfg.fields,
      quotationDate: { ...baseCfg.fields?.quotationDate, defaultValue: todayLocal() },
      // 切公司清币种,由 CompanyCurrencyDefault 按新公司本币重新带出
      companyId: { ...baseCfg.fields?.companyId, effects: () => ({ currencyId: null }) },
    },
  }

  return (
    <QuotationDrawerContext.Provider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="salQuotations"
        {...drawerCfg}
        mode={mode}
        isOpen={isOpen}
        isSubmitDisabled={mode === 'edit' && !drawer.detailLoaded}
        onOpenChange={(open) => {
          if (!open) drawer.close()
        }}
        // 表格列是白名单子集,行数据不全(缺条款/备注);不传 row,走 rowId 自查完整记录
        rowId={rowId}
        onEdit={
          quotationStatus === 'DRAFT'
            ? () => drawer.setMode('edit')
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => (
          <>
            <CompanyCurrencyDefault mode={mode} row={row} values={values} patchValues={patchValues} />
            <SynieEditableTable
              resource="salQuotationItems"
              label="报价条目"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !drawer.detailLoaded)}
              // 行表单物料/模式/单价双列排布,默认 420px 局促,加宽一档
              drawerClassName="w-full lg:w-[560px]"
              exclude={[
                'quotationId',
                'companyId',
                // 快照列由后端保存时重拍,不进录入表单;档数聚合列只服务条目 tab
                'materialCode',
                'materialName',
                'materialSpec',
                'customerPartNo',
                'unitName',
                'tierCount',
                // 头字段 calculation 只服务条目 tab 的跨单浏览,不进行级表单
                'quotationDate',
                'validUntil',
                'quotationStatus',
                'partyType',
                'partyId',
                'currencyCode',
              ]}
              columns={['idx', 'materialId', 'unitId', 'pricingMode', 'price', 'taxRate', 'remarks']}
              overrides={{
                pricingMode: { label: '定价模式' },
                // 固定价显单价,数量梯度显阶梯概要(≥量 价 / …)
                price: {
                  label: '含税单价',
                  render: (v, r) =>
                    r.pricingMode === 'QTY_TIERED' ? (
                      <span className="whitespace-nowrap">{tierSummary(rowTiers(r)) || '未设档'}</span>
                    ) : (
                      formatPrice(v)
                    ),
                },
                taxRate: { label: '税率(%)', render: (v) => formatPercent(v) },
                // 物料列:全站统一富单元格(快照四字段随受控行在表上);报价条目无图纸挂接,
                // 缩略图回退物料当前图纸;行上无快照文本时(本地新行/刚改选物料)返回 undefined
                // 回落默认 fk 渲染,保存后后端重拍快照
                materialId: {
                  label: '物料',
                  render: (v, row) =>
                    (row.materialCode != null && row.materialCode !== '') ||
                    (row.materialName != null && row.materialName !== '')
                      ? quotationItemMaterialCell(v, row)
                      : undefined,
                },
                unitId: {
                  render: (_v, r) => (r.unitName != null && r.unitName !== '' ? String(r.unitName) : undefined),
                },
              }}
              fields={{
                // 行号系统自动分配(transformItem),表格照常展示
                idx: { visible: () => false },
                materialId: {
                  order: 0,
                  required: true,
                  // 报价可售库存/虚拟物料(资产不可售);后端权威拦截兜底
                  remote: { filterState: { materialType: { kind: 'enum', values: ['STOCK', 'VIRTUAL'] } } },
                  // 切换物料时清掉已选单位,避免单位候选跟着旧物料走
                  effects: () => ({ unitId: null }),
                  // 客户物料适配由资源端校验兜底。
                },
                unitId: {
                  order: 1,
                  cols: 6,
                  required: true,
                  input: ({ value, onChange, isDisabled, values }) => (
                    <MaterialUnitSelect
                      materialId={values.materialId == null ? null : String(values.materialId)}
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                },
                // 定价模式:固定价走行上单价,数量梯度走价格档子表(下方 extraContent)
                pricingMode: {
                  order: 2,
                  cols: 6,
                  required: true,
                  label: '定价模式',
                  defaultValue: 'FIXED',
                  // 切到梯度清行上单价(价在档上);切回固定价重新录入
                  effects: () => ({ price: null }),
                },
                price: {
                  order: 3,
                  cols: 6,
                  required: true,
                  label: '含税单价',
                  visible: (values) => values.pricingMode !== 'QTY_TIERED',
                },
                taxRate: {
                  order: 4,
                  cols: 6,
                  label: '税率(%)',
                  defaultValue: 0.13,
                  input: ({ value, onChange, isDisabled }) => (
                    <NumberField
                      fullWidth
                      isDisabled={isDisabled}
                      value={value == null || value === '' ? NaN : Math.round(Number(value) * 10000) / 100}
                      onChange={(n) => onChange(Number.isFinite(n) ? Math.round(n * 100) / 10000 : null)}
                    >
                      <Label>税率(%)</Label>
                      {/* 库样式 group 给步进按钮留列;不渲染步进按钮时改单列让 input 撑满 */}
                      <NumberField.Group className="grid-cols-[1fr]">
                        <NumberField.Input placeholder="如 13" />
                      </NumberField.Group>
                    </NumberField>
                  ),
                },
                remarks: { order: 5 },
              }}
              extraContent={(itemMode, itemRow, itemValues) =>
                itemValues.pricingMode === 'QTY_TIERED' ? (
                  <TierEditor
                    row={itemRow}
                    tiers={tierDraft}
                    onChange={setTierDraft}
                    initFrom={(r) => setTierDraft(r == null ? [] : rowTiers(r))}
                  />
                ) : null
              }
              validateItem={(vals, current, editing) => {
                const rate = Number(vals.taxRate)
                if (!(Number.isFinite(rate) && rate >= 0 && rate < 1)) return '税率必须在 0(含)与 100%(不含)之间'
                if (vals.pricingMode === 'QTY_TIERED') {
                  if (tierDraft.length === 0) return '数量梯度条目至少需要一个价格档'
                } else if (!(Number(vals.price) >= 0) || vals.price == null || vals.price === '') {
                  return '固定价条目必须填写含税单价'
                }
                const dup = current.some(
                  (r) =>
                    r.id !== editing?.id &&
                    String(r.materialId) === String(vals.materialId) &&
                    String(r.unitId) === String(vals.unitId)
                )
                if (dup) return '同一物料与单位在本报价单已有报价行'
              }}
              transformItem={(values, editing) => ({
                ...values,
                // 行号自动:存量行保号,新行取当前最大 idx+1(而非 length+1,避免删行后撞号)
                idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                // 梯度行单价空置(价在档上,后端 PricingRules 兜底);档草稿并入行,切回固定价即清档
                price: values.pricingMode === 'QTY_TIERED' ? null : values.price,
                tiers: values.pricingMode === 'QTY_TIERED' ? tierDraft : [],
                // 改选物料/单位后旧快照作废:清空让单元格回落 live 渲染,保存后后端重拍
                ...(editing != null && values.materialId !== editing.materialId
                  ? { materialName: null, materialCode: null, materialSpec: null, customerPartNo: null }
                  : {}),
                ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
              })}
            />
            {/* 报价条款置表单底部(条目表之下);值由页面自持,提交时并入 values */}
            <div className="mt-4">
              <TextField
                value={terms}
                onChange={setTerms}
                isDisabled={mode === 'view' || (mode !== 'create' && !drawer.detailLoaded)}
              >
                <Label>报价条款</Label>
                <TextArea rows={4} placeholder="对客户展示的报价条款,如付款、交付、有效条件约定" />
              </TextField>
            </div>
          </>
        )}
        onSubmit={async (values, mode) => {
          assertAggregateDraftReady(mode, drawer.detailLoaded, '销售报价明细')
          // 返回值供抽屉「保存并审核」取 id 调 REST action(通用约定)
          const draft = buildQuotationDraft(
            { ...draftHeadRef.current, ...values },
            terms,
            items,
          )
          let saved: Row
          if (mode === 'create') {
            saved = await salesQuotationDraft.createDraft(draft)
            toast.success('销售报价单已创建')
          } else {
            saved = await salesQuotationDraft.replaceDraft(
              rowId!,
              draft,
            )
            toast.success('销售报价单已更新')
          }
          await Promise.all([
            salesQuotationBinding.cache.invalidateAll(queryClient),
            salesQuotationItemBinding.cache.invalidateGrid(queryClient),
            salesQuotationTierBinding.cache.invalidateGrid(queryClient),
          ])
          return String(saved.id)
        }}
      />
    </QuotationDrawerContext.Provider>
  )
}
