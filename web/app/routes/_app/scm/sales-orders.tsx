import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, ListBox, NumberField, Select, TextArea, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/sales-orders')({
  component: SalesOrdersPage,
})

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
        id idx materialId unitId qty price amount taxRate remarks
        material { id name }
        unit { id name }
      }
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
// 行单位候选:物料默认单位 + 其单位转换行单位(与后端 MaterialUnitAllowed 校验同源,前端做体验层)
const FETCH_MATERIAL_UNITS = `
  query ($materialId: ID!) {
    invMaterials(filter: {id: {eq: $materialId}}, limit: 1, offset: 0) {
      results { id defaultUnit { id name } }
    }
    invMaterialUnits(filter: {materialId: {eq: $materialId}}, limit: 200, offset: 0) {
      results { id unit { id name } }
    }
  }
`

// mutation input 只收行自身字段:amount 后端系统算(writable? false)、companyId 冗余自订单(后端回填)、
// 本地草稿 id 与行上挂的 material/unit join 对象一律不进 payload
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

// 税率库存小数(0.13),前端一律按百分比展示/录入
const formatPercent = (v: unknown) => (v == null || v === '' ? '' : `${Math.round(Number(v) * 10000) / 100}%`)

// 本地日期 YYYY-MM-DD(不用 toISOString:UTC 串在 UTC+8 凌晨会差一天)
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 状态胶囊配色:草稿灰、已审核绿、已关闭黄、已作废红
const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  grossTotal: { label: '含税总额', render: (v: unknown) => formatAmount(v) },
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', CLOSED: 'warning', VOIDED: 'danger' } },
} satisfies Record<string, ColumnOverride>

// 常用列白名单:时间戳/审核人/录入人不进表格(兼当 exclude)
const GRID_COLUMNS = ['companyId', 'orderNo', 'orderDate', 'partyType', 'partyId', 'grossTotal', 'status']

// 状态机动作显隐:审核/删除仅草稿,关闭/作废仅已审核(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  close: (row: Row) => row.status === 'AUDITED',
  void: (row: Row) => row.status === 'AUDITED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

interface UnitOption {
  id: string
  name: string
}

/** 行单位下拉:候选 = 选中物料的默认单位 + 单位转换行单位;未选物料时禁用并提示 */
function UnitSelect({
  materialId,
  value,
  onChange,
  isDisabled,
}: {
  materialId: string | null
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
}) {
  const query = useQuery({
    queryKey: ['materialUnitOptions', materialId],
    enabled: materialId != null,
    staleTime: 60_000,
    queryFn: () =>
      gqlFetch<{
        invMaterials: { results: { defaultUnit: UnitOption | null }[] }
        invMaterialUnits: { results: { unit: UnitOption | null }[] }
      }>(FETCH_MATERIAL_UNITS, { materialId }).then((d) => {
        const units = [d.invMaterials.results[0]?.defaultUnit, ...d.invMaterialUnits.results.map((r) => r.unit)]
        // 默认单位与转换行不会重复(后端校验),仍按 id 去重兜底
        const seen = new Set<string>()
        return units.filter((u): u is UnitOption => u != null && !seen.has(u.id) && (seen.add(u.id), true))
      }),
  })
  const options = query.data ?? []

  // 选物料后默认带默认单位(options 首位即默认单位);用户已选(含编辑存量行)不覆盖
  useEffect(() => {
    if (value == null && options.length > 0) onChange(options[0].id)
  }, [value, options, onChange])

  return (
    <Select
      isDisabled={isDisabled || materialId == null}
      isRequired
      value={value == null || value === '' ? null : String(value)}
      onChange={(v) => onChange(v === '' ? null : v)}
    >
      <Label>单位</Label>
      <Select.Trigger>
        <Select.Value>
          {({ isPlaceholder, defaultChildren }) =>
            isPlaceholder ? (materialId == null ? '先选物料' : '选择单位…') : defaultChildren
          }
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((u) => (
            <ListBox.Item key={u.id} id={u.id} textValue={u.name}>
              {u.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )
}

function SalesOrdersPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // 交易条款不走抽屉字段(要排在条目表之下,抽屉 extraContent 固定在字段后渲染),由页面自持
  const [terms, setTerms] = useState('')
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号——防止慢响应把上一张订单的行回填到当前订单
  const reqIdRef = useRef(0)

  // 打开头抽屉:create 行与条款清空;view/edit 按订单 id 拉详情(条款+行,快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create') {
      setItems([])
      setItemsSnapshot([])
      setTerms('')
      return
    }
    gqlFetch<{ salOrders: { results: { terms: string | null }[] }; salOrderItems: { results: Row[] } }>(
      FETCH_DETAIL,
      { orderId: row!.id }
    )
      .then((d) => {
        if (my !== reqIdRef.current) return
        setTerms(d.salOrders.results[0]?.terms ?? '')
        setItems(d.salOrderItems.results)
        setItemsSnapshot(d.salOrderItems.results)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('订单详情加载失败', { description: (e as Error).message })
        setTerms('')
        setItems([])
        setItemsSnapshot([])
      })
  }

  // 抽屉配置:registry 一份;terms 从字段排除(改由 extraContent 底部渲染,提交时并入 values)
  const baseCfg = drawerConfig('salOrders')
  const drawerCfg = {
    ...baseCfg,
    exclude: [...(baseCfg.exclude ?? []), 'terms'],
    fields: { ...baseCfg.fields, orderDate: { order: 1, cols: 6, required: true, defaultValue: todayLocal() } },
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">销售订单</h1>
      <p className="mt-2 text-sm text-ink-500">
        公司向客户承诺供货的订货单据:草稿态可自由增删改行,审核后锁死(无反审核),仅可关闭或作废。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="salOrders"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
          actionVisible={ACTION_VISIBLE}
        />
      </div>

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
        rowId={drawer?.row?.id}
        onEdit={drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined}
        extraContent={(mode, row) => (
          <>
            <SynieEditableTable
            resource="salOrderItems"
            label="订单条目"
            items={items}
            onChange={setItems}
            readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT')}
            // 行表单物料/数量/单价双列排布,默认 420px 局促,加宽一档
            drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
            exclude={['orderId', 'companyId']}
            columns={['idx', 'materialId', 'unitId', 'qty', 'price', 'amount', 'taxRate', 'remarks']}
            overrides={{
              amount: { label: '含税金额', render: (v) => formatAmount(v) },
              taxRate: { label: '税率(%)', render: (v) => formatPercent(v) },
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
                  <UnitSelect
                    materialId={values.materialId == null ? null : String(values.materialId)}
                    value={value}
                    onChange={onChange}
                    isDisabled={isDisabled}
                  />
                ),
              },
              price: { order: 3, cols: 6, required: true },
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
                label: '含税金额',
                input: ({ values }) => {
                  const amt =
                    Math.round(((Number(values.qty) || 0) * (Number(values.price) || 0) + Number.EPSILON) * 100) / 100
                  return (
                    <NumberField fullWidth isDisabled value={amt}>
                      <Label>含税金额</Label>
                      <NumberField.Group className="grid-cols-[1fr]">
                        <NumberField.Input />
                      </NumberField.Group>
                    </NumberField>
                  )
                },
              },
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
            })}
          />
          {/* 交易条款置表单底部(条目表之下);值由页面自持,提交时并入 values */}
          <div className="mt-4">
            <TextField value={terms} onChange={setTerms} isDisabled={mode === 'view'}>
              <Label>交易条款</Label>
              <TextArea rows={4} placeholder="对客户展示的交易条款,如交付、付款、验收约定" />
            </TextField>
          </div>
          </>
        )}
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
            const orderId = drawer!.row!.id
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
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'salOrders'] })
        }}
      />
    </>
  )
}
