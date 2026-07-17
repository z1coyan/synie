import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, TextArea, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount, formatPrice } from '~/lib/amount'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

/**
 * 销售订单共享抽屉:布局层挂载一份,订单 tab(整单 grid)与订单条目 tab(行级 grid)
 * 经 context 调起同一个三态抽屉(条目表编辑/交易条款/提交 diff/审核流转动作完全一致)。
 */

/** 开抽屉需要的最小订单形状:订单 tab 传 grid 行;条目 tab 传 {id: orderId, status: orderStatus} */
export interface OrderRef {
  id: string
  /** 决定 view 态是否给「编辑」入口(DRAFT 才给);grid Row 是索引签名类型,故声明为可选 */
  status?: unknown
}

export type OpenOrderDrawer = (mode: DrawerMode, order: OrderRef | null) => void

const OrderDrawerContext = createContext<OpenOrderDrawer>(() => {})

/** 子路由(订单/订单条目)取 openDrawer:view/edit 传 {id, status},create 传 null */
export function useOrderDrawer(): OpenOrderDrawer {
  return useContext(OrderDrawerContext)
}

const CREATE_ORDER = `
  mutation ($input: CreateSalOrderInput!) {
    createSalOrder(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ORDER = `
  mutation ($id: ID!, $input: UpdateSalOrderInput!) {
    updateSalOrder(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_DETAIL = `
  query ($orderId: ID!) {
    salOrders(filter: {id: {eq: $orderId}}, limit: 1, offset: 0) {
      results { id terms }
    }
    salOrderItems(filter: {orderId: {eq: $orderId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
      results {
        id idx materialId unitId qty price amount basePrice baseAmount taxRate remarks
        materialName unitName
        material { id name }
        unit { id name }
      }
    }
  }
`
// 单据公司的本币:决定汇率字段显隐、币种默认值与条目表双币列(整单本币时只显一套)
const FETCH_COMPANY_BASE = `
  query ($companyId: ID!) {
    basCompanies(filter: {id: {eq: $companyId}}, limit: 1, offset: 0) {
      results { id baseCurrencyId }
    }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateSalOrderItemInput!) {
    createSalOrderItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateSalOrderItemInput!) {
    updateSalOrderItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroySalOrderItem(id: $id) { errors { message } }
  }
`

// mutation input 只收行自身字段:amount 后端系统算(writable? false)、companyId 冗余自订单(后端回填)、
// 快照字段(materialName/unitName 等)由后端保存时重拍,本地草稿 id 与行上挂的 material/unit join 对象一律不进 payload
function itemInput(row: Row) {
  return {
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    price: row.price,
    taxRate: row.taxRate,
    remarks: row.remarks ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['idx', 'materialId', 'unitId', 'qty', 'price', 'taxRate', 'remarks'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy。全程收集错误文案(带行号定位),不中途抛出(同凭证分录行先例) */
async function persistItems(orderId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroySalOrderItem: { errors: { message: string }[] | null } }>(
      DESTROY_ITEM,
      { id: old.id }
    )
    collect(old.idx, data.destroySalOrderItem.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createSalOrderItem: { errors: { message: string }[] | null } }>(
        CREATE_ITEM,
        { input: { orderId, ...itemInput(row) } }
      )
      collect(row.idx, data.createSalOrderItem.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updateSalOrderItem: { errors: { message: string }[] | null } }>(
        UPDATE_ITEM,
        { id: row.id, input: itemInput(row) }
      )
      collect(row.idx, data.updateSalOrderItem.errors)
    }
  }
  return errors
}

// 税率库存小数(0.13),前端一律按百分比展示/录入(条目 tab 的 taxRate 列也用它渲染)
export const formatPercent = (v: unknown) => (v == null || v === '' ? '' : `${Math.round(Number(v) * 10000) / 100}%`)

// 本地即时换算(展示层;保存时后端权威重算):值×汇率按 dp 位四舍五入,非数值回 null
function mulRound(v: unknown, rate: number, dp: number): number | null {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** dp
  return Math.round((n * rate + Number.EPSILON) * f) / f
}

/**
 * 公司本币同步(渲染为 null 的表单伴生组件):
 * 1. 按单据公司查本币,上报给 provider(汇率字段显隐、条目表双币列都依赖它);
 * 2. create/edit 态币种为空时(新建初始、切公司被 effects 清空)默认公司本币。
 * 外币单的币种已有值,不会被覆盖(编辑存量外币单安全)。
 */
function CompanyCurrencySync({
  mode,
  row,
  values,
  patchValues,
  onBaseCurrency,
}: {
  mode: DrawerMode
  row: Row | null | undefined
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  onBaseCurrency: (id: string | null) => void
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

  useEffect(() => {
    onBaseCurrency(base)
  }, [base, onBaseCurrency])

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

export function OrderDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; order: OrderRef | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // 交易条款不走抽屉字段(要排在条目表之下,抽屉 extraContent 固定在字段后渲染),由页面自持
  const [terms, setTerms] = useState('')
  // edit/view 态条目与条款靠 FETCH_DETAIL 异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [detailLoaded, setDetailLoaded] = useState(false)
  // 单据公司本币(CompanyCurrencySync 上报):汇率显隐、币种默认、条目表双币列都依赖它
  const [baseCurrencyId, setBaseCurrencyId] = useState<string | null>(null)
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一张订单的行回填到当前订单
  const reqIdRef = useRef(0)

  // 打开头抽屉:create 行与条款清空;view/edit 按订单 id 拉详情(条款+行,快照留作提交时 diff 基准)。
  // useCallback 稳定引用:context 值不变,两个 tab 的 grid overrides 不会因父级重渲染而失效
  const openDrawer: OpenOrderDrawer = useCallback((mode, order) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, order })
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setTerms('')
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    gqlFetch<{ salOrders: { results: { terms: string | null }[] }; salOrderItems: { results: Row[] } }>(
      FETCH_DETAIL,
      { orderId: order!.id }
    )
      .then((d) => {
        if (my !== reqIdRef.current) return
        setTerms(d.salOrders.results[0]?.terms ?? '')
        setItems(d.salOrderItems.results)
        setItemsSnapshot(d.salOrderItems.results)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('订单详情加载失败', { description: (e as Error).message })
        setTerms('')
        setItems([])
        setItemsSnapshot([])
      })
  }, [])

  // 抽屉配置:registry 一份;terms 从字段排除(改由 extraContent 底部渲染,提交时并入 values)
  const baseCfg = drawerConfig('salOrders')
  const drawerCfg = {
    ...baseCfg,
    exclude: [...(baseCfg.exclude ?? []), 'terms'],
    fields: {
      ...baseCfg.fields,
      orderDate: { order: 1, cols: 6, required: true, defaultValue: todayLocal() },
      // 切公司清币种/汇率,由 CompanyCurrencySync 按新公司本币重新带出
      companyId: { ...baseCfg.fields?.companyId, effects: () => ({ currencyId: null, exchangeRate: null }) },
      // 切币种重置汇率:切到本币后端强制 1(字段随即隐藏),切到外币要求重填
      currencyId: { ...baseCfg.fields?.currencyId, effects: () => ({ exchangeRate: null }) },
      // 汇率仅外币单可见且必填;本币单不出字段、不进提交(后端 SyncCurrency 强制 1)。
      // view 态 values 即行数据,同一判定对详情展示同样生效
      exchangeRate: {
        ...baseCfg.fields?.exchangeRate,
        required: true,
        visible: (values) =>
          baseCurrencyId != null &&
          values.currencyId != null &&
          values.currencyId !== '' &&
          String(values.currencyId) !== baseCurrencyId,
      },
    },
  }

  return (
    <OrderDrawerContext.Provider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="salOrders"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          // 关闭即作废在途请求并清空快照,防止残留快照被下次提交按差异写误用到别的订单
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
          setTerms('')
        }}
        // 表格列是白名单子集,行数据不全(缺交易条款/备注);不传 row,走 rowId 自查完整记录
        rowId={drawer?.order?.id}
        onEdit={drawer?.order?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined}
        extraContent={(mode, row, values, patchValues) => {
          // 整单币种/汇率:编辑态读表单草稿,查看态读行数据(rowId 自查含全字段)。
          // 整单本币只显一套单价/金额;外币展开双套列(展示简化只在单订单上下文,条目 tab 恒全列)
          const currencyId = String((mode === 'view' ? row?.currencyId : (values.currencyId ?? row?.currencyId)) ?? '')
          const isForeign = baseCurrencyId != null && currencyId !== '' && currencyId !== baseCurrencyId
          const rawRate = mode === 'view' ? row?.exchangeRate : (values.exchangeRate ?? row?.exchangeRate)
          const rate = Number.isFinite(Number(rawRate)) && Number(rawRate) > 0 ? Number(rawRate) : 1
          const priceLabel = isForeign ? '原币含税单价' : '含税单价'
          const amountLabel = isForeign ? '原币含税金额' : '含税金额'
          return (
          <>
            <CompanyCurrencySync
              mode={mode}
              row={row}
              values={values}
              patchValues={patchValues}
              onBaseCurrency={setBaseCurrencyId}
            />
            <SynieEditableTable
            resource="salOrderItems"
            label="订单条目"
            items={items}
            onChange={setItems}
            readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)}
            // 行表单物料/数量/单价双列排布,默认 420px 局促,加宽一档
            drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
            exclude={[
              'orderId',
              'companyId',
              // 快照列由后端保存时重拍,不进录入表单;不影响表格显示(columns 白名单本就不含它们)
              'materialCode',
              'materialName',
              'materialSpec',
              'customerPartNo',
              'unitName',
              // 头字段 calculation 只服务条目 tab 的跨单浏览,不进行级表单
              // (双币列 basePrice/baseAmount 要上表格,不能进 exclude,表单用 visible:false 隐藏)
              'orderDate',
              'orderStatus',
              'partyType',
              'partyId',
              'currencyCode',
            ]}
            columns={
              isForeign
                ? ['idx', 'materialId', 'unitId', 'qty', 'basePrice', 'price', 'baseAmount', 'amount', 'taxRate', 'remarks']
                : ['idx', 'materialId', 'unitId', 'qty', 'price', 'amount', 'taxRate', 'remarks']
            }
            overrides={{
              // 表格列头用短标签(同层级与本币列对齐);行表单字段才用「含税」长标签
              price: { label: isForeign ? '原币单价' : '含税单价' },
              amount: { label: isForeign ? '原币金额' : '含税金额', render: (v) => formatAmount(v) },
              // 双币列按当前汇率即时换算展示(编辑中改汇率立即跟手;保存时后端权威重算落库)
              basePrice: { label: '本币单价', render: (_v, r) => formatPrice(mulRound(r.price, rate, 4)) },
              baseAmount: { label: '本币金额', render: (_v, r) => formatAmount(mulRound(r.amount, rate, 2)) },
              taxRate: { label: '税率(%)', render: (v) => formatPercent(v) },
              // 物料/单位列显示口径:行快照名(下单时落库,防主数据改名);无快照返回 undefined 回落默认 fk 渲染
              // ——本地新行/编辑中刚改选的行按 join 或 id 反查显示今日名(编辑本来就是选今天的物料,保存后后端重拍)
              materialId: {
                render: (_v, row) =>
                  row.materialName != null && row.materialName !== '' ? String(row.materialName) : undefined,
              },
              unitId: {
                render: (_v, row) => (row.unitName != null && row.unitName !== '' ? String(row.unitName) : undefined),
              },
            }}
            fields={{
              // 行号系统自动分配(transformItem),表格照常展示
              idx: { visible: () => false },
              // 字段顺序:物料→数量→单位→单价→税率→金额(只读)
              materialId: {
                order: 0,
                required: true,
                // 切换物料时清掉已选单位,避免单位候选跟着旧物料走
                effects: () => ({ unitId: null }),
              },
              qty: { order: 1, cols: 6, required: true },
              unitId: {
                order: 2,
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
              price: { order: 3, cols: 6, required: true, label: priceLabel },
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
                    {/* 库样式 group 给步进按钮留列;不渲染步进按钮时改单列让 input 撑满(同抽屉默认数值控件) */}
                    <NumberField.Group className="grid-cols-[1fr]">
                      <NumberField.Input placeholder="如 13" />
                    </NumberField.Group>
                  </NumberField>
                ),
              },
              // 含税金额系统算(后端 writable? false):表单只读展示 数量×单价 即时结果,不录入(提交 payload 见 itemInput)
              amount: {
                order: 5,
                cols: 6,
                label: amountLabel,
                input: ({ values }) => {
                  const amt =
                    Math.round(((Number(values.qty) || 0) * (Number(values.price) || 0) + Number.EPSILON) * 100) / 100
                  return (
                    <NumberField fullWidth isDisabled value={amt}>
                      <Label>{amountLabel}</Label>
                      <NumberField.Group className="grid-cols-[1fr]">
                        <NumberField.Input />
                      </NumberField.Group>
                    </NumberField>
                  )
                },
              },
              // 本币单价仅作表格展示参考,不进行表单;本币金额外币单给只读预览(本币单与原币恒同值,不显)
              basePrice: { visible: () => false },
              baseAmount: isForeign
                ? {
                    order: 6,
                    cols: 6,
                    label: '本币含税金额',
                    input: ({ values }) => {
                      const amt =
                        Math.round(((Number(values.qty) || 0) * (Number(values.price) || 0) + Number.EPSILON) * 100) /
                        100
                      return (
                        <NumberField fullWidth isDisabled value={mulRound(amt, rate, 2) ?? 0}>
                          <Label>本币含税金额</Label>
                          <NumberField.Group className="grid-cols-[1fr]">
                            <NumberField.Input />
                          </NumberField.Group>
                        </NumberField>
                      )
                    },
                  }
                : { visible: () => false },
            }}
            validateItem={(vals) => {
              if (!(Number(vals.qty) > 0)) return '数量必须大于零'
              if (!(Number(vals.price) >= 0)) return '含税单价不能为负'
              const rate = Number(vals.taxRate)
              if (!(Number.isFinite(rate) && rate >= 0 && rate < 1)) return '税率必须在 0(含)与 100%(不含)之间'
            }}
            transformItem={(values, editing) => ({
              ...values,
              // 行号自动:存量行保号,新行取当前最大 idx+1(而非 length+1,避免删行后撞号)
              idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
              // 金额本地即时显示;保存时后端权威重算
              amount: Math.round(((Number(values.qty) || 0) * (Number(values.price) || 0) + Number.EPSILON) * 100) / 100,
              // 改选物料/单位后旧快照名作废(mergeItem 清旧 join 同理):清空让单元格回落 live 渲染,保存后后端重拍
              ...(editing != null && values.materialId !== editing.materialId ? { materialName: null } : {}),
              ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
            })}
          />
          {/* 交易条款置表单底部(条目表之下);值由页面自持,提交时并入 values */}
          <div className="mt-4">
            <TextField value={terms} onChange={setTerms} isDisabled={mode === 'view' || (mode !== 'create' && !detailLoaded)}>
              <Label>交易条款</Label>
              <TextArea rows={4} placeholder="对客户展示的交易条款,如交付、付款、验收约定" />
            </TextField>
          </div>
          </>
          )
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createSalOrder: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_ORDER, { input: { ...values, terms: terms === '' ? null : terms } })
            if (data.createSalOrder.errors && data.createSalOrder.errors.length > 0) {
              throw new Error(data.createSalOrder.errors.map((e) => e.message).join('; '))
            }
            const orderId = data.createSalOrder.result!.id
            const itemErrors = await persistItems(orderId, items, [])
            if (itemErrors.length > 0) {
              toast.danger('订单已创建,但部分条目保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('销售订单已创建')
            }
          } else {
            const orderId = drawer!.order!.id
            const data = await gqlFetch<{
              updateSalOrder: { errors: { message: string }[] | null }
            }>(UPDATE_ORDER, { id: orderId, input: { ...values, terms: terms === '' ? null : terms } })
            if (data.updateSalOrder.errors && data.updateSalOrder.errors.length > 0) {
              throw new Error(data.updateSalOrder.errors.map((e) => e.message).join('; '))
            }
            const itemErrors = await persistItems(orderId, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('订单已更新,但部分条目保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('销售订单已更新')
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salOrders'] })
          // 条目 tab 的行级 grid 也要失效:条目增删改/整单提交都落在 salOrderItems 上
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'salOrderItems'] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'salOrders'] })
        }}
      />
    </OrderDrawerContext.Provider>
  )
}
