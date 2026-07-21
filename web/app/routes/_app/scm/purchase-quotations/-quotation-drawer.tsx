import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, TextArea, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatPrice } from '~/lib/amount'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

/**
 * 采购报价单共享抽屉:布局层挂载一份,报价单 tab(整单 grid)与报价条目 tab(行级 grid)
 * 经 context 调起同一个三态抽屉。三层录入:报价抽屉 → 条目表(SynieEditableTable)→
 * 条目二级抽屉内嵌价格档子表(extraContent 透传,数量梯度条目专用)。
 * 价格档草稿由本页自持(collectValues 会剥离非字段键,不能塞进抽屉草稿),
 * 提交经条目 transformItem 并入行数据、persistItems 时按差异持久化。
 * 与销售报价的唯一差异:对手限供应商/内部公司,条目选料不校验客户物料约束(任何物料可录)。
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

const CREATE_QUOTATION = `
  mutation ($input: CreatePurQuotationInput!) {
    createPurQuotation(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_QUOTATION = `
  mutation ($id: ID!, $input: UpdatePurQuotationInput!) {
    updatePurQuotation(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 价格档整单一次取回(经条目关系过滤),按 itemId 归组挂到行上
const FETCH_DETAIL = `
  query ($quotationId: ID!) {
    purQuotations(filter: {id: {eq: $quotationId}}, limit: 1, offset: 0) {
      results { id terms }
    }
    purQuotationItems(filter: {quotationId: {eq: $quotationId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
      results {
        id idx materialId unitId pricingMode price taxRate remarks
        materialName unitName
        material { id name }
        unit { id name }
      }
    }
    purQuotationTiers(filter: {item: {quotationId: {eq: $quotationId}}}, sort: [{field: MIN_QTY, order: ASC}], limit: 1000, offset: 0) {
      results { id itemId minQty price }
    }
  }
`
// 单据公司的本币:create/edit 态币种默认值(报价单无汇率,不需要外币联动)
const FETCH_COMPANY_BASE = `
  query ($companyId: ID!) {
    basCompanies(filter: {id: {eq: $companyId}}, limit: 1, offset: 0) {
      results { id baseCurrencyId }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreatePurQuotationItemInput!) {
    createPurQuotationItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdatePurQuotationItemInput!) {
    updatePurQuotationItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyPurQuotationItem(id: $id) { errors { message } }
  }
`
const CREATE_TIER = `
  mutation ($input: CreatePurQuotationTierInput!) {
    createPurQuotationTier(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_TIER = `
  mutation ($id: ID!, $input: UpdatePurQuotationTierInput!) {
    updatePurQuotationTier(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_TIER = `
  mutation ($id: ID!) {
    destroyPurQuotationTier(id: $id) { errors { message } }
  }
`

// mutation input 只收行自身字段:companyId 冗余自报价单(后端回填)、快照字段由后端保存时
// 重拍;梯度行单价强制空置(后端 PricingRules 兜底);tiers/join 对象不进 payload
function itemInput(row: Row) {
  return {
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    pricingMode: row.pricingMode,
    price: row.pricingMode === 'QTY_TIERED' ? null : row.price,
    taxRate: row.taxRate,
    remarks: row.remarks ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['idx', 'materialId', 'unitId', 'pricingMode', 'price', 'taxRate', 'remarks'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

function rowTiers(row: Row): Row[] {
  return (row.tiers as Row[] | undefined) ?? []
}

function tierChanged(before: Row, after: Row): boolean {
  return String(before.minQty ?? '') !== String(after.minQty ?? '') || String(before.price ?? '') !== String(after.price ?? '')
}

/** 单个条目的价格档差异持久化(条目已存在/已更新后调用);切回固定价由后端清档,不在此发删除 */
async function persistTiers(itemId: string, itemIdx: unknown, row: Row, snapshot: Row[], errors: string[]) {
  const collect = (msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${itemIdx}行价格档:${e.message}`))
  }
  if (row.pricingMode !== 'QTY_TIERED') return

  const current = rowTiers(row)
  const currentIds = new Set(current.filter((t) => !isLocalRow(t)).map((t) => t.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyPurQuotationTier: { errors: { message: string }[] | null } }>(
      DESTROY_TIER,
      { id: old.id }
    )
    collect(data.destroyPurQuotationTier.errors)
  }

  for (const tier of current) {
    if (isLocalRow(tier)) {
      const data = await gqlFetch<{ createPurQuotationTier: { errors: { message: string }[] | null } }>(
        CREATE_TIER,
        { input: { itemId, minQty: tier.minQty, price: tier.price } }
      )
      collect(data.createPurQuotationTier.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === tier.id)
    if (old && tierChanged(old, tier)) {
      const data = await gqlFetch<{ updatePurQuotationTier: { errors: { message: string }[] | null } }>(
        UPDATE_TIER,
        { id: tier.id, input: { minQty: tier.minQty, price: tier.price } }
      )
      collect(data.updatePurQuotationTier.errors)
    }
  }
}

/**
 * 行差异持久化:本地草稿行 create(再建其价格档);存量行有变 update,档按差异增改删;
 * 快照有、当前无 destroy(档随行 DB 级联)。全程收集错误文案(带行号定位),
 * 不中途抛出(同销售报价先例)。条目先于档写入——固定价切梯度时档必须挂在已是梯度模式的行上。
 */
async function persistItems(quotationId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyPurQuotationItem: { errors: { message: string }[] | null } }>(
      DESTROY_ITEM,
      { id: old.id }
    )
    collect(old.idx, data.destroyPurQuotationItem.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{
        createPurQuotationItem: { result: { id: string } | null; errors: { message: string }[] | null }
      }>(CREATE_ITEM, { input: { quotationId, ...itemInput(row) } })
      collect(row.idx, data.createPurQuotationItem.errors)
      const newId = data.createPurQuotationItem.result?.id
      if (newId) await persistTiers(newId, row.idx, row, [], errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updatePurQuotationItem: { errors: { message: string }[] | null } }>(
        UPDATE_ITEM,
        { id: row.id, input: itemInput(row) }
      )
      collect(row.idx, data.updatePurQuotationItem.errors)
    }
    await persistTiers(String(row.id), row.idx, row, old ? rowTiers(old) : [], errors)
  }
  return errors
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
    queryFn: () =>
      gqlFetch<{ basCompanies: { results: { baseCurrencyId: string | null }[] } }>(FETCH_COMPANY_BASE, {
        companyId,
      }).then((d) => d.basCompanies.results[0]?.baseCurrencyId ?? null),
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

// 本地日期 YYYY-MM-DD(不用 toISOString:UTC 串在 UTC+8 凌晨会差一天)
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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
      resource="purQuotationTiers"
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

export function QuotationDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; quotation: QuotationRef | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // 报价条款不走抽屉字段(要排在条目表之下,抽屉 extraContent 固定在字段后渲染),由页面自持
  const [terms, setTerms] = useState('')
  // edit/view 态条目与条款靠 FETCH_DETAIL 异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [detailLoaded, setDetailLoaded] = useState(false)
  // 条目二级抽屉在编条目的价格档草稿(collectValues 剥离非字段键,不能进抽屉 values)
  const [tierDraft, setTierDraft] = useState<Row[]>([])
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一张单的行回填到当前单
  const reqIdRef = useRef(0)

  const openDrawer: OpenQuotationDrawer = useCallback((mode, quotation) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, quotation })
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setTerms('')
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{
      purQuotations: { results: { terms: string | null }[] }
      purQuotationItems: { results: Row[] }
      purQuotationTiers: { results: Row[] }
    }>(FETCH_DETAIL, { quotationId: quotation!.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        // 价格档按 itemId 归组挂上行(行内 tiers 保持起订量升序,查询已排序)
        const byItem = new Map<string, Row[]>()
        for (const t of d.purQuotationTiers.results) {
          const key = String(t.itemId)
          byItem.set(key, [...(byItem.get(key) ?? []), t])
        }
        const rows = d.purQuotationItems.results.map((r) => ({ ...r, tiers: byItem.get(String(r.id)) ?? [] }))
        setTerms(d.purQuotations.results[0]?.terms ?? '')
        setItems(rows)
        setItemsSnapshot(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('报价单详情加载失败', { description: (e as Error).message })
        setTerms('')
        setItems([])
        setItemsSnapshot([])
      })
  }, [])

  // 抽屉配置:registry 一份;terms 从字段排除(改由 extraContent 底部渲染,提交时并入 values)
  const baseCfg = drawerConfig('purQuotations')
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
        resource="purQuotations"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          // 关闭即作废在途请求并清空快照,防止残留快照被下次提交按差异写误用到别的报价单
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          setTerms('')
        }}
        // 表格列是白名单子集,行数据不全(缺条款/备注);不传 row,走 rowId 自查完整记录
        rowId={drawer?.quotation?.id}
        onEdit={
          drawer?.quotation?.status === 'DRAFT'
            ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
            : undefined
        }
        extraContent={(mode, row, values, patchValues) => (
          <>
            <CompanyCurrencyDefault mode={mode} row={row} values={values} patchValues={patchValues} />
            <SynieEditableTable
              resource="purQuotationItems"
              label="报价条目"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)}
              // 行表单物料/模式/单价双列排布,默认 420px 局促,加宽一档
              drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
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
                // 物料/单位列显示口径:行快照名(报价时落库,防主数据改名);无快照回落默认 fk 渲染
                materialId: {
                  render: (_v, r) =>
                    r.materialName != null && r.materialName !== '' ? String(r.materialName) : undefined,
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
                  // 切换物料时清掉已选单位,避免单位候选跟着旧物料走。
                  // 采购侧不校验客户物料约束:任何物料均可报价(无 remote filter)
                  effects: () => ({ unitId: null }),
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
                // 改选物料/单位后旧快照名作废:清空让单元格回落 live 渲染,保存后后端重拍
                ...(editing != null && values.materialId !== editing.materialId ? { materialName: null } : {}),
                ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
              })}
            />
            {/* 报价条款置表单底部(条目表之下);值由页面自持,提交时并入 values */}
            <div className="mt-4">
              <TextField
                value={terms}
                onChange={setTerms}
                isDisabled={mode === 'view' || (mode !== 'create' && !detailLoaded)}
              >
                <Label>报价条款</Label>
                <TextArea rows={4} placeholder="对供应商展示的报价条款,如付款、交付、有效条件约定" />
              </TextField>
            </div>
          </>
        )}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createPurQuotation: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_QUOTATION, { input: { ...values, terms: terms === '' ? null : terms } })
            if (data.createPurQuotation.errors && data.createPurQuotation.errors.length > 0) {
              throw new Error(data.createPurQuotation.errors.map((e) => e.message).join('; '))
            }
            const quotationId = data.createPurQuotation.result!.id
            const itemErrors = await persistItems(quotationId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('报价单已创建,但部分条目保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('采购报价单已创建')
            }
          } else {
            const quotationId = drawer!.quotation!.id
            const data = await gqlFetch<{
              updatePurQuotation: { errors: { message: string }[] | null }
            }>(UPDATE_QUOTATION, { id: quotationId, input: { ...values, terms: terms === '' ? null : terms } })
            if (data.updatePurQuotation.errors && data.updatePurQuotation.errors.length > 0) {
              throw new Error(data.updatePurQuotation.errors.map((e) => e.message).join('; '))
            }
            const itemErrors = await persistItems(quotationId, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('报价单已更新,但部分条目保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('采购报价单已更新')
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purQuotations'] })
          // 条目 tab 的行级 grid 也要失效:条目/价格档增删改都落在 purQuotationItems 上
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'purQuotationItems'] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'purQuotations'] })
        }}
      />
    </QuotationDrawerContext.Provider>
  )
}
