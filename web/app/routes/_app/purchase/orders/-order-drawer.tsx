import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Label, ListBox, Modal, NumberField, Select, TextArea, TextField, toast } from '@heroui/react'
import { isForbidden } from '~/lib/errors'
import { companyClient } from '~/lib/resources/companies'
import {
  expandPurchaseOrderBom,
  purchaseOrderItemClient,
} from '~/lib/resources/orders'
import { buildOrderDraft, type OrderSavedDraft } from '~/lib/resources/order-draft'
import { assertAggregateDraftReady } from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftFor,
  resourceBindingFor,
} from '~/lib/resources/registry'
import { getSalesSetting } from '~/lib/resources/settings'
import { formatAmount, formatPrice } from '~/lib/amount'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { localRowId } from '~/components/synie-editable-table/editable'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { auditMaterialCell, type AuditDocConfig } from '../../scm/-audit-doc'
import { OrderFlowHistory } from '../../scm/-order-flow-history'
import { DemandLinePicker } from './-demand-line-picker'
import { ItemsResetGuard } from '~/components/items-reset-guard'
import { todayLocal } from '~/lib/form-defaults'
import { toastError } from '~/lib/toast'
import {
  createDocumentDrawerOpenBridge,
  useDocumentDrawer,
} from '~/lib/use-document-drawer'

const purchaseOrderBinding = resourceBindingFor('purOrders')
const purchaseOrderItemBinding = resourceBindingFor('purOrderItems')
const purchaseOrderItemMaterialBinding = resourceBindingFor(
  'purOrderItemMaterials',
)
const purchaseOrderItemByproductBinding = resourceBindingFor(
  'purOrderItemByproducts',
)
const purchaseOrderDraft = aggregateDraftFor('purOrders')

/**
 * 采购订单共享抽屉:布局层挂载一份,订单 tab(整单 grid)与订单条目 tab(行级 grid)
 * 经 context 调起同一个三态抽屉(条目表编辑/交易条款/提交聚合草稿/审核流转动作完全一致)。
 * 订单分型:常规订单条目只能从有效采购报价条目挑选(物料/单位/单价随报价锁定带出,税率带入可改,
 * 数量梯度条目价保存时由后端按数量套档);零星订单条目自由录入,单行数量受供应链设置上限约束。
 * 采购侧不校验客户物料约束:零星行任何物料可录。类型建后锁死(后端 OrderTypeLocked 报错兜底,
 * 前端编辑态禁用)。
 */

/** 开抽屉需要的最小订单形状:订单 tab 传 grid 行;条目 tab 传 {id: orderId, status: orderStatus} */
export interface OrderRef {
  id: string
  /** 决定 view 态是否给「编辑」入口(DRAFT 才给);grid Row 是索引签名类型,故声明为可选 */
  status?: unknown
}

export type OpenOrderDrawer = (mode: DrawerMode, order: OrderRef | null) => void

// 「审核整单」确认弹窗配置:条目页行操作与订单页「审核」动作共用(见 scm/-audit-doc)
// 列只取行上快照/计算字段(materialCode 等保存时已冻结),不 join 会触发嵌套授权的 fk
export const purchaseOrderAuditConfig = {
  docLabel: '采购订单',
  resource: 'purOrders',
  commandKey: 'audit',
  itemsResource: 'purOrderItems',
  loadItems: (orderId: string) =>
    purchaseOrderItemClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        fixedFilter: {
          orderId: { kind: 'fk', op: 'in', values: [orderId], labels: [] },
        },
      })
      .then((result) => result.results),
  columns: [
    {
      key: 'materialName',
      label: '物料',
      render: auditMaterialCell({ drawingOwnerType: 'pur_order_item' }),
    },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '数量', align: 'end' },
    { key: 'price', label: '含税单价', align: 'end', render: (v: unknown) => formatPrice(v) },
    { key: 'amount', label: '含税金额', align: 'end', render: (v: unknown) => formatAmount(v) },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

const {
  useOpen: useOrderDrawer,
  Provider: OrderDrawerOpenProvider,
} = createDocumentDrawerOpenBridge<OpenOrderDrawer>()
export { useOrderDrawer }


// 行上委外配置子表集合的读取(行对象附加键,不进 mutation payload)
const issueLinesOf = (row: Row | null | undefined): Row[] => (row?.issueLines as Row[] | undefined) ?? []
const byproductLinesOf = (row: Row | null | undefined): Row[] => (row?.byproductLines as Row[] | undefined) ?? []

// 税率库存小数(0.13),前端一律按百分比展示/录入(条目 tab 的 taxRate 列也用它渲染)
export const formatPercent = (v: unknown) => (v == null || v === '' ? '' : `${Math.round(Number(v) * 10000) / 100}%`)

// 条目表物料单元格:全站统一富单元格(图纸缩略图+快照四字段,编号点开物料速览;行图纸挂接 pur_order_item)
const orderItemMaterialCell = materialCellRender({ drawingOwnerType: 'pur_order_item' })

// ── 委外配置(发料清单/副产物清单)─────────────────────────────────────────────

// BOM 选项标签:编号为主(独立编号唯一),方案名称辅助区分同物料多张
const bomOptionLabel = (bom: Row) =>
  `${String(bom.code ?? '')}${bom.planName != null && bom.planName !== '' ? `(${String(bom.planName)})` : ''}`

// 两子表共用录入字段:材料切换清单位(候选随材料走);已发料量是后端投影,不进表单
function subLineFields(withIssued: boolean): Record<string, FieldOverride> {
  return {
    materialId: {
      order: 0,
      required: true,
      // 发料/副产物限库存物料(虚拟/资产无实物);后端权威拦截兜底
      remote: { filterState: { materialType: { kind: 'enum', values: ['STOCK'] } } },
      effects: () => ({ unitId: null }),
    },
    unitId: {
      order: 1,
      cols: 6,
      required: true,
      input: ({ value, onChange, isDisabled, values: lineValues }) => (
        <MaterialUnitSelect
          materialId={lineValues.materialId == null ? null : String(lineValues.materialId)}
          value={value}
          onChange={onChange}
          isDisabled={isDisabled}
        />
      ),
    },
    quantity: { order: 2, cols: 6, required: true, label: '数量' },
    ...(withIssued ? { issuedQty: { visible: () => false } } : {}),
    remarks: { order: 3 },
  }
}

const subLineValidate = (vals: Record<string, unknown>) => {
  if (!vals.materialId) return '请选择材料'
  if (!(Number(vals.quantity) > 0)) return '数量必须大于零'
}

/**
 * 条目行抽屉内的委外配置区(仅委外订单渲染):发料清单/副产物清单两个子表 + 「从 BOM 代入」。
 * 行对象上的 issueLines/byproductLines 是真源(随订单 Aggregate Draft 整体持久化);
 * 抽屉打开期间由本组件内部 state 接管,经 syncRef 上报,行提交时由 transformItem 并回行对象。
 * 代入是快照复制:代入后与 BOM 脱钩可自由增删改,改条目数量不自动重算(重算=清空清单再代入)。
 */
function OutsourcedConfig({
  itemRow,
  itemValues,
  syncRef,
}: {
  itemRow: Row | null
  itemValues: Record<string, unknown>
  syncRef: MutableRefObject<{ issue: Row[]; byproduct: Row[] } | null>
}) {
  const [issue, setIssue] = useState<Row[]>(() => issueLinesOf(itemRow))
  const [byproduct, setByproduct] = useState<Row[]>(() => byproductLinesOf(itemRow))
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    syncRef.current = { issue, byproduct }
  }, [issue, byproduct, syncRef])

  const bomId = itemValues.bomId == null || itemValues.bomId === '' ? null : String(itemValues.bomId)
  const qty = Number(itemValues.qty)
  // 与 BOM「从模板带入」同例:代入是整表重建,不与手录行混排——清单非空须先清空再代入
  const canApply = bomId != null && Number.isFinite(qty) && qty > 0 && issue.length === 0 && byproduct.length === 0

  const applyBom = async () => {
    if (bomId == null) return
    setApplying(true)
    try {
      const result = await expandPurchaseOrderBom(bomId, qty)
      const toLine = (r: (typeof result.materials)[number]) => ({
        id: localRowId(),
        materialId: r.materialId,
        unitId: r.unitId,
        quantity: Number(r.quantity),
        remarks: r.remarks ?? null,
        materialName: r.materialName,
        unitName: r.unitName,
        material: {
          id: String(r.materialId),
          code: r.materialCode,
          name: r.materialName,
        },
        unit: { id: String(r.unitId), name: r.unitName },
      })
      setIssue(result.materials.map(toLine))
      setByproduct(result.byproducts.map(toLine))
      toast.success('已按 BOM 代入发料清单与副产物清单')
    } catch (e) {
      toastError('BOM 代入失败')(e)
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-separator pt-4">
      <SynieEditableTable
        resource="purOrderItemMaterials"
        label="发料清单"
        items={issue}
        onChange={setIssue}
        exclude={['orderItemId', 'companyId']}
        columns={['materialId', 'unitId', 'quantity', 'issuedQty', 'remarks']}
        fields={subLineFields(true)}
        validateItem={subLineValidate}
        toolbar={
          <>
            {bomId == null ? (
              <span className="self-center text-xs text-muted">先选成品 BOM 再代入</span>
            ) : issue.length > 0 || byproduct.length > 0 ? (
              <span className="self-center text-xs text-muted">清空清单后可重新代入</span>
            ) : null}
            <Button size="sm" variant="secondary" isDisabled={!canApply} isPending={applying} onPress={() => void applyBom()}>
              从 BOM 代入
            </Button>
          </>
        }
      />
      <SynieEditableTable
        resource="purOrderItemByproducts"
        label="副产物清单"
        items={byproduct}
        onChange={setByproduct}
        exclude={['orderItemId', 'companyId']}
        columns={['materialId', 'unitId', 'quantity', 'remarks']}
        fields={subLineFields(false)}
        validateItem={subLineValidate}
      />
    </div>
  )
}

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
      companyClient.get(companyId).then((company) =>
        typeof company?.baseCurrencyId === 'string' ? company.baseCurrencyId : null,
      ),
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

/**
 * 头字段变更清行守卫(ItemsResetGuard)的指纹字段:订单类型/公司/对手类型/对手/订单日期/币种
 * 任一变化即清空条目草稿(已落库行由提交时的快照 diff 走删除,与手动逐行删除同路径)。
 */
const ITEMS_RESET_FIELDS = ['orderType', 'companyId', 'partyType', 'partyId', 'orderDate', 'currencyId'] as const

/**
 * 采购订单创建/编辑抽屉(头+条目+条款,含委外配置)。
 * 订单/订单条目两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function OrderDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<OrderSavedDraft>({
    resource: 'purOrders',
    urlSync,
    loadDraft: (id) => purchaseOrderDraft.loadDraft(id),
  })
  const { isOpen, mode, rowId } = drawer
  // 编辑入口:urlSync 用 hook 自查行 status;本地态用 open 传入的 order.status
  const orderStatus = drawer.row?.status
  const [items, setItems] = useState<Row[]>([])
  // 交易条款不走抽屉字段(要排在条目表之下,抽屉 extraContent 固定在字段后渲染),由页面自持
  const [terms, setTerms] = useState('')
  // 单据公司本币(CompanyCurrencySync 上报):汇率显隐、币种默认、条目表双币列都依赖它
  const [baseCurrencyId, setBaseCurrencyId] = useState<string | null>(null)
  // 报价条目缓存(id → 行):选择时写入完整行(物料快照名等即时带出),存量行由 REST 详情回填定价模式;
  // 行表单的梯度判定(tieredSelected)与 transformItem 的快照名带出都读它
  const quotationItemsRef = useRef(new Map<string, Row>())
  // 条目行抽屉内委外配置两子表的最新草稿(OutsourcedConfig 经 effect 上报),行提交时 transformItem 并回行对象
  const subSyncRef = useRef<{ issue: Row[]; byproduct: Row[] } | null>(null)
  // 查看态「委外配置」弹窗:只读展示该行的 BOM 与两清单(行抽屉只在编辑态存在,查看态走这里)
  const [linesView, setLinesView] = useState<Row | null>(null)
  const queryClient = useQueryClient()
  const draftHeadRef = useRef<Row | null>(null)

  // 零星单行数量上限:抽屉打开时查一次(5 分钟 stale);无权限/失败按 null 降级(跳过客户端校验,后端兜底)
  const salSettingQuery = useQuery({
    queryKey: ['salSetting'],
    enabled: isOpen,
    staleTime: 300_000,
    retry: false,
    queryFn: () =>
      getSalesSetting().catch((e) => {
        if (!isForbidden(e)) console.warn('供应链设置查询失败,零星数量上限客户端校验跳过:', (e as Error).message)
        return null
      }),
  })
  const spotMaxQty = salSettingQuery.data?.spotItemMaxQty ?? null

  // 头四要素/币种变化清空条目草稿;空集合并保留原引用,避免无谓重渲染
  const resetItems = useCallback(() => setItems((cur) => (cur.length === 0 ? cur : [])), [])

  // 草稿 → 条目/条款状态派生:draft 变化(含关闭/新建清空为 null)时初始化条目与条款,
  // 并把报价条目定价模式摊平到行(价格/金额列的梯度展示判定)、回填缓存供行表单只读派生;
  // 与选择时写入的完整行合并,不覆盖已有的快照名
  useEffect(() => {
    draftHeadRef.current = drawer.draft
    const rows = (drawer.draft?.items ?? []).map((r) => {
      const quotationItemId =
        r.quotationItemId == null ? null : String(r.quotationItemId)
      if (quotationItemId && r.pricingMode) {
        const prev = quotationItemsRef.current.get(quotationItemId) ?? ({} as Row)
        quotationItemsRef.current.set(quotationItemId, {
          ...prev,
          id: quotationItemId,
          pricingMode: r.pricingMode,
        })
      }
      return {
        ...r,
        bom:
          r.bomId == null
            ? null
            : { id: r.bomId, code: r.bomCode, planName: r.bomPlanName },
        pricingMode: r.pricingMode ?? null,
        issueLines: r.issueLines,
        byproductLines: r.byproductLines,
      }
    })
    setTerms(String(drawer.draft?.terms ?? ''))
    setItems(rows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  // 打开头抽屉:create 行与条款清空;view/edit 按订单 id 拉详情(条款+行,快照留作提交时 diff 基准)
  const openDrawer: OpenOrderDrawer = (nextMode, order) => {
    drawer.open(nextMode, order)
  }

  // 抽屉配置:registry 一份;terms 从字段排除(改由 extraContent 底部渲染,提交时并入 values)
  const baseCfg = drawerConfig('purOrders')
  const drawerCfg = {
    ...baseCfg,
    exclude: [...(baseCfg.exclude ?? []), 'terms'],
    fields: {
      ...baseCfg.fields,
      // 订单类型提到最前:新建必选默认常规;建后锁死(createOnly 编辑态禁用且不进更新 payload,后端 OrderTypeLocked 兜底)
      orderType: {
        order: -2,
        cols: 6,
        required: true,
        label: '订单类型',
        defaultValue: 'REGULAR',
        edit: 'createOnly' as const,
        input: ({ value, onChange, isDisabled }: { value: unknown; onChange: (v: unknown) => void; isDisabled: boolean }) => (
          <Select
            isDisabled={isDisabled}
            isRequired
            value={value == null || value === '' ? null : String(value)}
            onChange={(v) => onChange(v === '' ? null : v)}
          >
            <Label>订单类型</Label>
            <Select.Trigger>
              <Select.Value>
                {({ isPlaceholder, defaultChildren }) => (isPlaceholder ? '请选择…' : defaultChildren)}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                <ListBox.Item key="REGULAR" id="REGULAR" textValue="常规订单">
                  常规订单
                  <ListBox.ItemIndicator />
                </ListBox.Item>
                <ListBox.Item key="SPOT" id="SPOT" textValue="零星订单">
                  零星订单
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              </ListBox>
            </Select.Popover>
          </Select>
        ),
      },
      orderDate: { order: 1, cols: 6, required: true, defaultValue: todayLocal() },
      // 委外标记:新建期可勾选,保存后锁死(createOnly 编辑态禁用且不进更新 payload,后端 OutsourcedLocked 兜底);
      // 勾选即委外订单——条目=委外回来的成品、条目含税单价=加工费单价,与订单类型正交
      isOutsourced: { order: 0, cols: 6, label: '委外标记', edit: 'createOnly' as const, defaultValue: false },
      // 切公司清币种/汇率,由 CompanyCurrencySync 按新公司本币重新带出
      companyId: { ...baseCfg.fields?.companyId, effects: () => ({ currencyId: null, exchangeRate: null }) },
      // 切币种重置汇率:切到本币后端强制 1(字段随即隐藏),切到外币要求重填
      currencyId: { ...baseCfg.fields?.currencyId, effects: () => ({ exchangeRate: null }) },
      // 汇率仅外币单可见且必填;本币单不出字段、不进提交(后端 SyncCurrency 强制 1)。
      // view 态 values 即行数据,同一判定对详情展示同样生效
      exchangeRate: {
        ...baseCfg.fields?.exchangeRate,
        required: true,
        visible: (values: Record<string, unknown>) =>
          baseCurrencyId != null &&
          values.currencyId != null &&
          values.currencyId !== '' &&
          String(values.currencyId) !== baseCurrencyId,
      },
    },
  }

  return (
    <OrderDrawerOpenProvider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="purOrders"
        {...drawerCfg}
        mode={mode}
        isOpen={isOpen}
        isSubmitDisabled={mode === 'edit' && !drawer.detailLoaded}
        onOpenChange={(open) => {
          if (!open) drawer.close()
        }}
        // 表格列是白名单子集,行数据不全(缺交易条款/备注);不传 row,走 rowId 自查完整记录
        rowId={rowId}
        onEdit={
          orderStatus === 'DRAFT' ? () => drawer.setMode('edit') : undefined
        }
        // 首 tab 为现有单页内容(字段+条目表+交易条款,经 extraContent 自动归入);收发货历史只读展示
        tabs={[
          { key: 'basic', label: '基本信息' },
          { key: 'flows', label: '收发货历史' },
        ]}
        tabExtraContent={{
          flows: (_mode, row) =>
            row?.id == null ? (
              <p className="text-sm text-muted">订单保存后可查看收发货历史</p>
            ) : (
              // 采购入库/委外发料/委外入库同表列出(委外订单的发出与回收进度同视角)
              <OrderFlowHistory orderId={String(row.id)} side="purchase" />
            ),
        }}
        extraContent={(mode, row, values, patchValues) => {
          // 整单币种/汇率:编辑态读表单草稿,查看态读行数据(rowId 自查含全字段)。
          // 整单本币只显一套单价/金额;外币展开双套列(展示简化只在单订单上下文,条目 tab 恒全列)
          const currencyId = String((mode === 'view' ? row?.currencyId : (values.currencyId ?? row?.currencyId)) ?? '')
          const isForeign = baseCurrencyId != null && currencyId !== '' && currencyId !== baseCurrencyId
          const rawRate = mode === 'view' ? row?.exchangeRate : (values.exchangeRate ?? row?.exchangeRate)
          const rate = Number.isFinite(Number(rawRate)) && Number(rawRate) > 0 ? Number(rawRate) : 1
          const priceLabel = isForeign ? '原币含税单价' : '含税单价'
          const amountLabel = isForeign ? '原币含税金额' : '含税金额'
          // 订单类型:编辑态读表单草稿,查看态读行数据;决定条目行表单形态(报价条目选择器 vs 自由录入)
          const orderType = String((mode === 'view' ? row?.orderType : (values.orderType ?? row?.orderType)) ?? 'REGULAR')
          const isSpot = orderType === 'SPOT'
          // 委外标记:同上按态读取;决定是否出成品 BOM 选择与两清单子表(委外配置全部可选,不配不挡开单)
          const isOutsourced = Boolean(mode === 'view' ? row?.isOutsourced : (values.isOutsourced ?? row?.isOutsourced))
          // 头四要素(类型/公司/对手/日期)选齐才放开条目新增;缺任一给提示文案
          const headerReady = Boolean(
            values.orderType && values.companyId && values.partyType && values.partyId && values.orderDate
          )
          // 常规单条目的有效报价过滤:报价单已审核 + 公司/对手/币种与订单一致 + 订单日期落在报价区间
          // (与后端 QuotationLink 审核复核同口径);币种由公司本币自动带出,可能短暂为空——空则禁用选择器
          const quotationFilter = (() => {
            const { companyId, partyType, partyId, currencyId: cid, orderDate } = values
            if (!companyId || !partyType || !partyId || !cid || !orderDate) return null
            return {
              quotationStatus: { kind: 'enum', values: ['AUDITED'] },
              companyId: { kind: 'fk', op: 'in', values: [String(companyId)], labels: [] },
              partyType: { kind: 'enum', values: [String(partyType)] },
              partyId: {
                kind: 'polyFk',
                op: 'in',
                variant: String(partyType),
                values: [String(partyId)],
                labels: [],
              },
              currencyId: { kind: 'fk', op: 'in', values: [String(cid)], labels: [] },
              quotationDate: { kind: 'date', op: 'between', lte: String(orderDate) },
              validUntil: { kind: 'date', op: 'between', gte: String(orderDate) },
            } satisfies FilterState
          })()
          // 梯度报价条目判定:选中条目的定价模式从缓存取(选择时写完整行;存量行由 FETCH_DETAIL 回填)
          const tieredSelected = (vals: Record<string, unknown>) =>
            vals.quotationItemId != null &&
            quotationItemsRef.current.get(String(vals.quotationItemId))?.pricingMode === 'QTY_TIERED'
          // 常规单首位是报价条目选择器,其余字段顺移一位;零星单维持原有排布
          const fo = isSpot ? 0 : 1
          // 只读文本占位(梯度价/金额:保存时后端按数量套档派生,本地无价可算)
          const tieredText = (label: string) => (
            <TextField isDisabled value="按数量套档">
              <Label>{label}</Label>
              <Input />
            </TextField>
          )
          // 条目录入字段:常规单物料列换成有效报价条目选择器(物料/单位/单价随报价锁定带出为只读,
          // 数量/税率/备注可改);零星单维持自由录入。只读控件的字段仍是 editable——值由选择器带出并正常提交
          const itemFields: Record<string, FieldOverride> = {
            // 行号系统自动分配(transformItem),表格照常展示
            idx: { visible: () => false },
            quotationItemId: isSpot
              ? // 零星行不得挂报价条目(后端校验兜底):表单不出字段,聚合草稿恒送 null
                { visible: () => false }
              : {
                  order: 0,
                  required: true,
                  label: '报价条目',
                  input: ({ value, onChange, isDisabled, patchValues: patchItem }) => (
                    <RemoteSelect
                      resource="purQuotationItems"
                      label="报价条目"
                      placeholder={quotationFilter ? '选择有效报价条目…' : '订单头信息未选齐'}
                      labelField="materialName"
                      searchFields={['materialName', 'materialCode']}
                      filterState={quotationFilter ?? undefined}
                      fields={[
                        'materialCode',
                        'unitName',
                        'price',
                        'pricingMode',
                        'taxRate',
                        'materialId',
                        'unitId',
                        'quotation { id quotationNo }',
                      ]}
                      value={value == null ? null : String(value)}
                      onChange={(id, qitem) => {
                        if (qitem) quotationItemsRef.current.set(String(qitem.id), qitem)
                        onChange(id)
                        // 物料/单位/单价随报价锁定带出(后端 DeriveQuotation 强制派生兜底);税率带入可改;
                        // 数量梯度条目价保存时按数量套档,本地置空
                        patchItem({
                          materialId: qitem?.materialId ?? null,
                          unitId: qitem?.unitId ?? null,
                          price:
                            qitem == null || qitem.pricingMode === 'QTY_TIERED' || qitem.price == null
                              ? null
                              : Number(qitem.price),
                          taxRate: qitem?.taxRate == null ? null : Number(qitem.taxRate),
                        })
                      }}
                      isDisabled={isDisabled || quotationFilter == null}
                      isRequired
                      renderValue={(r) => String(r.materialName ?? '')}
                      renderItem={(r) => {
                        const quotation = r.quotation as Row | null | undefined
                        const tiered = r.pricingMode === 'QTY_TIERED'
                        return (
                          <div className="flex flex-col">
                            <span className="text-sm">
                              {String(r.materialName ?? '')}({String(r.materialCode ?? '')})
                            </span>
                            <span className="text-xs text-muted">
                              {String(quotation?.quotationNo ?? '')} · {String(r.unitName ?? '')} ·{' '}
                              {tiered ? '按数量套档' : formatPrice(r.price)} · {tiered ? '数量梯度' : '固定价'}
                            </span>
                          </div>
                        )
                      }}
                    />
                  ),
                },
            materialId: isSpot
              ? {
                  order: 0,
                  required: true,
                  // 切换物料时清掉已选单位,避免单位候选跟着旧物料走。
                  // 采购侧不校验客户物料约束:任何物料均可录入(无 remote filter)
                  effects: () => ({ unitId: null }),
                }
              : {
                  order: fo,
                  required: true,
                  label: '物料',
                  // 随报价锁定,只读展示(值由报价条目带出,照常提交;后端强制派生)
                  input: ({ value }) => (
                    <RemoteSelect
                      resource="invMaterials"
                      label="物料"
                      value={value == null ? null : String(value)}
                      onChange={() => {}}
                      isDisabled
                    />
                  ),
                },
            qty: { order: fo + 1, cols: 6, required: true },
            unitId: isSpot
              ? {
                  order: 2,
                  cols: 6,
                  required: true,
                  input: ({ value, onChange, isDisabled, values: itemValues }) => (
                    <MaterialUnitSelect
                      materialId={itemValues.materialId == null ? null : String(itemValues.materialId)}
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                }
              : {
                  order: fo + 2,
                  cols: 6,
                  required: true,
                  label: '单位',
                  // 随报价锁定,只读展示(同物料列)
                  input: ({ value }) => (
                    <RemoteSelect
                      resource="basUnits"
                      label="单位"
                      value={value == null ? null : String(value)}
                      onChange={() => {}}
                      isDisabled
                    />
                  ),
                },
            price: isSpot
              ? { order: 3, cols: 6, required: true, label: priceLabel }
              : {
                  order: fo + 3,
                  cols: 6,
                  label: priceLabel,
                  // 随报价锁定:固定价只读展示带出价;数量梯度保存时按数量套档派生,只读提示
                  input: ({ value, values: itemValues }) =>
                    tieredSelected(itemValues) ? (
                      tieredText(priceLabel)
                    ) : (
                      <NumberField
                        fullWidth
                        isDisabled
                        value={value == null || value === '' ? NaN : Number(value)}
                        onChange={() => {}}
                      >
                        <Label>{priceLabel}</Label>
                        <NumberField.Group className="grid-cols-[1fr]">
                          <NumberField.Input />
                        </NumberField.Group>
                      </NumberField>
                    ),
                },
            taxRate: {
              order: fo + 4,
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
            // 含税金额系统算(后端 writable? false):表单只读展示 数量×单价 即时结果,不录入聚合草稿;
            // 常规单梯度条目无价可算,只读提示
            amount: {
              order: fo + 5,
              cols: 6,
              label: amountLabel,
              input: ({ values: itemValues }) => {
                if (!isSpot && tieredSelected(itemValues)) return tieredText(amountLabel)
                const amt =
                  Math.round(((Number(itemValues.qty) || 0) * (Number(itemValues.price) || 0) + Number.EPSILON) * 100) / 100
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
                  order: fo + 6,
                  cols: 6,
                  label: '本币含税金额',
                  input: ({ values: itemValues }) => {
                    if (!isSpot && tieredSelected(itemValues)) return tieredText('本币含税金额')
                    const amt =
                      Math.round(((Number(itemValues.qty) || 0) * (Number(itemValues.price) || 0) + Number.EPSILON) * 100) /
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
            // 成品 BOM(委外配置,可空):限选条目物料自身的 BOM(后端 BomMaterialMatch 兜底),
            // 按编号/方案名称区分同物料多张;仅留痕,选后可在下方「从 BOM 代入」两清单
            bomId: !isOutsourced
              ? { visible: () => false }
              : {
                  order: fo + 7,
                  label: '成品 BOM',
                  input: ({ value, onChange, isDisabled, values: itemValues }) => (
                    <RemoteSelect
                      resource="mfgBoms"
                      label="成品 BOM"
                      placeholder={itemValues.materialId ? '选择该物料的 BOM(可空)…' : '先选物料'}
                      labelField="code"
                      searchFields={['code', 'planName']}
                      filterState={
                        itemValues.materialId != null
                          ? { materialId: { kind: 'fk', values: [String(itemValues.materialId)], labels: [] } }
                          : undefined
                      }
                      fields={['code', 'planName']}
                      value={value == null ? null : String(value)}
                      onChange={onChange}
                      isDisabled={isDisabled || itemValues.materialId == null}
                      renderValue={(r) => bomOptionLabel(r)}
                      renderItem={(r) => (
                        <div className="flex flex-col">
                          <span className="text-sm">{bomOptionLabel(r)}</span>
                        </div>
                      )}
                    />
                  ),
                },
          }
          // 条目表只读口径(查看态/非草稿/详情未加载完):行抽屉与委外配置编辑同此闸
          const itemsReadOnly = mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !drawer.detailLoaded)
          return (
          <>
            <CompanyCurrencySync
              mode={mode}
              row={row}
              values={values}
              patchValues={patchValues}
              onBaseCurrency={setBaseCurrencyId}
            />
            <ItemsResetGuard mode={mode} row={row} values={values} fields={ITEMS_RESET_FIELDS} onReset={resetItems} />
            <SynieEditableTable
            resource="purOrderItems"
            label="订单条目"
            items={items}
            onChange={setItems}
            readOnly={itemsReadOnly}
            // 头四要素(类型/公司/对手/日期)未选齐禁止新增;币种由公司带出,选择器内部另有兜底
            canCreate={headerReady}
            toolbar={
              mode !== 'view' && !headerReady ? (
                <span className="text-xs text-muted">先选齐订单类型、公司、对手与订单日期</span>
              ) : !itemsReadOnly && headerReady ? (
                <DemandLinePicker
                  companyId={values.companyId ? String(values.companyId) : null}
                  isOutsourced={isOutsourced}
                  nextIdx={items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1}
                  onConfirm={(rows) => {
                    setItems([...items, ...rows])
                    toast.success(`已从需求单带入 ${rows.length} 行`)
                  }}
                />
              ) : undefined
            }
            // 行表单物料/数量/单价双列排布,默认 420px 局促,加宽一档
            drawerClassName="w-full lg:w-[560px]"
            exclude={[
              'orderId',
              'companyId',
              // 快照列由后端保存时重拍,不进录入表单;不影响表格显示(columns 白名单本就不含它们)
              'materialCode',
              'materialName',
              'materialSpec',
              'customerPartNo',
              'unitName',
              // 系统算/投影列:折默认单位、已收、未收均由后端维护(writable? false),不进表单
              'baseQty',
              'receivedQty',
              'remainingBaseQty',
              // 头字段 calculation 只服务条目 tab 的跨单浏览,不进行级表单
              // (双币列 basePrice/baseAmount 要上表格,不能进 exclude,表单用 visible:false 隐藏)
              'orderDate',
              'orderStatus',
              'partyType',
              'partyId',
              'currencyCode',
              'orderIsOutsourced',
            ]}
            columns={
              isForeign
                ? [
                    'idx',
                    'materialId',
                    'unitId',
                    'qty',
                    'basePrice',
                    'price',
                    'baseAmount',
                    'amount',
                    'taxRate',
                    'demandLineId',
                    'demandDate',
                    'remarks',
                  ]
                : [
                    'idx',
                    'materialId',
                    'unitId',
                    'qty',
                    'price',
                    'amount',
                    'taxRate',
                    'demandLineId',
                    'demandDate',
                    'remarks',
                  ]
            }
            overrides={{
              // 表格列头用短标签(同层级与本币列对齐);行表单字段才用「含税」长标签。
              // 梯度条目价保存时才套档派生:本地无价显「按数量套档」,已有派生价(后端返回)照常显示
              price: {
                label: isForeign ? '原币单价' : '含税单价',
                render: (v, r) => (r.pricingMode === 'QTY_TIERED' && (v == null || v === '') ? '按数量套档' : undefined),
              },
              amount: {
                label: isForeign ? '原币金额' : '含税金额',
                render: (v, r) =>
                  r.pricingMode === 'QTY_TIERED' && (v == null || v === '') ? '按数量套档' : formatAmount(v),
              },
              // 双币列按当前汇率即时换算展示(编辑中改汇率立即跟手;保存时后端权威重算)
              basePrice: { label: '本币单价', render: (_v, r) => formatPrice(mulRound(r.price, rate, 4)) },
              baseAmount: {
                label: '本币金额',
                render: (_v, r) =>
                  r.pricingMode === 'QTY_TIERED' && r.amount == null
                    ? '按数量套档'
                    : formatAmount(mulRound(r.amount, rate, 2)),
              },
              taxRate: { label: '税率(%)', render: (v) => formatPercent(v) },
              // 物料列:全站统一富单元格(快照四字段+图纸);行上无快照文本时(本地新行/刚改选物料,
              // 如零星自由行/需求带入行)返回 undefined 回落默认 fk 渲染,保存后后端重拍快照
              materialId: {
                label: '物料',
                render: (v, row) =>
                  (row.materialCode != null && row.materialCode !== '') ||
                  (row.materialName != null && row.materialName !== '')
                    ? orderItemMaterialCell(v, row)
                    : undefined,
              },
              unitId: {
                render: (_v, row) => (row.unitName != null && row.unitName !== '' ? String(row.unitName) : undefined),
              },
            }}
            fields={itemFields}
            // 行抽屉内挂委外配置区(仅委外订单):成品 BOM 字段在上方表单,两清单子表 + 代入在此
            extraContent={(itemMode, itemRow, itemValues) =>
              isOutsourced && itemMode !== 'view' ? (
                <OutsourcedConfig key={itemRow?.id ?? 'new'} itemRow={itemRow ?? null} itemValues={itemValues} syncRef={subSyncRef} />
              ) : null
            }
            // 查看态行抽屉不存在,委外配置走只读弹窗
            rowActions={
              itemsReadOnly && isOutsourced
                ? (itemRow) => (
                    <Button size="sm" variant="ghost" onPress={() => setLinesView(itemRow)}>
                      委外配置
                    </Button>
                  )
                : undefined
            }
            validateItem={(vals) => {
              if (!(Number(vals.qty) > 0)) return '数量必须大于零'
              // 零星行数量上限:salSetting 查不到(无权限/失败)时跳过客户端校验,后端建行与审核复核兜底
              if (isSpot && spotMaxQty != null && Number(vals.qty) > spotMaxQty)
                return `零星条目数量不能超过上限 ${spotMaxQty}`
              // 常规单梯度条目 price 置空(保存时后端套档派生),Number(null)=0 自然放行
              if (!(Number(vals.price) >= 0)) return '含税单价不能为负'
              const rate = Number(vals.taxRate)
              if (!(Number.isFinite(rate) && rate >= 0 && rate < 1)) return '税率必须在 0(含)与 100%(不含)之间'
            }}
            transformItem={(values, editing) => {
              const qitem =
                values.quotationItemId != null ? quotationItemsRef.current.get(String(values.quotationItemId)) : undefined
              const tiered = qitem?.pricingMode === 'QTY_TIERED'
              // 委外配置两子表:行抽屉打开期间的最新草稿(OutsourcedConfig 上报),并回行对象随条目 diff 持久化
              const sub = subSyncRef.current
              return {
                ...values,
                // 行号自动:存量行保号,新行取当前最大 idx+1(而非 length+1,避免删行后撞号)
                idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                // 金额本地即时显示;梯度条目无价可算留空(表格显「按数量套档」),保存时后端权威重算
                amount: tiered
                  ? null
                  : Math.round(((Number(values.qty) || 0) * (Number(values.price) || 0) + Number.EPSILON) * 100) / 100,
                // 报价条目定价模式随行走(表格价格/金额列与行表单的梯度展示判定):缓存优先,存量行沿用
                pricingMode: qitem?.pricingMode ?? editing?.pricingMode ?? null,
                issueLines: sub?.issue ?? issueLinesOf(editing),
                byproductLines: sub?.byproduct ?? byproductLinesOf(editing),
                // 改选物料/单位后旧快照作废(mergeItem 清旧 join 同理):清空让单元格回落 live 渲染,保存后后端重拍;
                // 换物料后原 BOM 引用必然不匹配(限条目物料自身),一并清空
                ...(editing != null && values.materialId !== editing.materialId
                  ? { materialName: null, materialCode: null, materialSpec: null, customerPartNo: null, bomId: null }
                  : {}),
                ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
                // 新选报价条目即时带出快照编号/名称(选择时缓存的是完整行);缓存缺名(存量行)保持原快照不动
                ...(qitem?.materialName != null ? { materialName: qitem.materialName } : {}),
                ...(qitem?.materialCode != null ? { materialCode: qitem.materialCode } : {}),
                ...(qitem?.unitName != null ? { unitName: qitem.unitName } : {}),
              }
            }}
          />
          {/* 交易条款置表单底部(条目表之下);值由页面自持,提交时并入 values */}
          <div className="mt-4">
            <TextField value={terms} onChange={setTerms} isDisabled={mode === 'view' || (mode !== 'create' && !drawer.detailLoaded)}>
              <Label>交易条款</Label>
              <TextArea rows={4} placeholder="对供应商展示的交易条款,如交付、付款、验收约定" />
            </TextField>
          </div>
          </>
          )
        }}
        onSubmit={async (values, mode) => {
          assertAggregateDraftReady(mode, drawer.detailLoaded, '采购订单明细')
          const draft = buildOrderDraft(
            'purchase',
            { ...draftHeadRef.current, ...values },
            terms,
            items,
          )
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let saved: Row
          if (mode === 'create') {
            saved = await purchaseOrderDraft.createDraft(draft)
            toast.success('采购订单已创建')
          } else {
            saved = await purchaseOrderDraft.replaceDraft(
              rowId!,
              draft,
            )
            toast.success('采购订单已更新')
          }
          await Promise.all([
            purchaseOrderBinding.cache.invalidateAll(queryClient),
            purchaseOrderItemBinding.cache.invalidateGrid(queryClient),
            purchaseOrderItemMaterialBinding.cache.invalidateGrid(queryClient),
            purchaseOrderItemByproductBinding.cache.invalidateGrid(queryClient),
          ])
          return String(saved.id)
        }}
      />

      {/* 查看态委外配置(只读):行抽屉只在编辑态存在,查看/非草稿单走此弹窗看 BOM 与两清单 */}
      <Modal.Backdrop isOpen={linesView != null} onOpenChange={(open) => !open && setLinesView(null)}>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl">
            <Modal.Header>
              <Modal.Heading>委外配置</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {linesView != null && (
                <div className="flex flex-col gap-4">
                  <p className="text-sm">
                    成品 BOM:
                    {(linesView.bom as Row | null | undefined) != null
                      ? bomOptionLabel(linesView.bom as Row)
                      : '未配置'}
                  </p>
                  <SynieEditableTable
                    resource="purOrderItemMaterials"
                    label="发料清单"
                    items={issueLinesOf(linesView)}
                    onChange={() => {}}
                    readOnly
                    exclude={['orderItemId', 'companyId']}
                    columns={['materialId', 'unitId', 'quantity', 'issuedQty', 'remarks']}
                    fields={subLineFields(true)}
                  />
                  <SynieEditableTable
                    resource="purOrderItemByproducts"
                    label="副产物清单"
                    items={byproductLinesOf(linesView)}
                    onChange={() => {}}
                    readOnly
                    exclude={['orderItemId', 'companyId']}
                    columns={['materialId', 'unitId', 'quantity', 'remarks']}
                    fields={subLineFields(false)}
                  />
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setLinesView(null)}>
                关闭
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </OrderDrawerOpenProvider>
  )
}
