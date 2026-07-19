import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Label, NumberField, Switch, toast } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'

export const Route = createFileRoute('/_app/scm/stock-counts')({
  component: StockCountsPage,
})

/**
 * 库存盘点单(ADR 2026-07-19-stock-count):核对账实并校正库存的来源单据,
 * 单头一仓、行即本次要盘的物料清单;允许部分盘点——未列入的物料不受影响。
 * 状态机 草稿→已审核→(已作废):仅草稿可改可删;审核(approve,grid_actions 内建确认)
 * 按「实盘折算 − 账面快照」差异派生库存分录(盘盈正、盘亏负,零差异行不落);
 * 作废(cancel,内建确认)标记分录作废。账面数量是取数时刻快照不做冻结:
 * 创建/整仓带出/刷新账面数时取数,草稿详情页提供「刷新账面数」(refresh,保留已填实盘数);
 * 取快照后该仓分录有新增/作废则审核被拒,提示先刷新。新建可开「整仓带出」
 * (create 传 loadAll: true)按该仓账面余额非零的物料建行,账面零的物料手工加行。
 * 页面形态照手工调拨单:顶部公司选择器 + 按公司过滤的单据 grid + 三态抽屉
 * (头字段 + SynieEditableTable 行表,行随父表单提交一并持久化)。
 * 折算实盘/账面数量系统算(后端 writable? false),行表单只读占位、行表格展示。
 */

const CREATE_DOC = `
  mutation ($input: CreateInvStockCountInput!) {
    createInvStockCount(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_DOC = `
  mutation ($id: ID!, $input: UpdateInvStockCountInput!) {
    updateInvStockCount(id: $id, input: $input) { result { id } errors { message } }
  }
`
const CREATE_ITEM = `
  mutation ($input: CreateInvStockCountItemInput!) {
    createInvStockCountItem(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ITEM = `
  mutation ($id: ID!, $input: UpdateInvStockCountItemInput!) {
    updateInvStockCountItem(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ITEM = `
  mutation ($id: ID!) {
    destroyInvStockCountItem(id: $id) { errors { message } }
  }
`
// 刷新账面数:update 动作无 input(同 audit/void 先例),仅草稿可用
const REFRESH_DOC = `
  mutation ($id: ID!) {
    refreshInvStockCount(id: $id) { result { id } errors { message } }
  }
`
// 行无 idx(与出入库/调拨行不同):按创建序展示
const FETCH_ITEMS = `
  query ($docId: ID!) {
    invStockCountItems(filter: {countId: {eq: $docId}}, sort: [{field: INSERTED_AT, order: ASC}], limit: 200, offset: 0) {
      results {
        id materialId unitId countedQuantity convertedCounted bookQuantity remark materialName unitName
        material { id name }
        unit { id name }
      }
    }
  }
`

// 列表列白名单:公司由页面顶部选定不进列,录入人/审核人/时间戳不进表格(兼当 exclude)
const GRID_COLUMNS = ['docNo', 'postingDate', 'warehouseId', 'status', 'summary', 'auditedAt']

// 状态胶囊配色:草稿灰、已审核绿、已作废红(同手工出入库单先例)
const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', CANCELLED: 'danger' } },
  summary: { width: 240 },
} satisfies Record<string, ColumnOverride>

// 状态机动作显隐:审核/编辑/删除仅草稿,作废仅已审核(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  approve: (row: Row) => row.status === 'DRAFT',
  cancel: (row: Row) => row.status === 'AUDITED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// 本地日期 YYYY-MM-DD(不用 toISOString:UTC 串在 UTC+8 凌晨会差一天;同销售订单先例)
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

interface MutationResult {
  result?: { id: string } | null
  errors: { message: string }[] | null
}

// mutation input 只收行自身字段:convertedCounted/bookQuantity 系统算(writable? false)、
// companyId 冗余自母单(后端回填)、快照字段(materialName/unitName 等)由后端保存时重拍;
// 实盘数量审核前可空,原样透传(null 即未填)
function itemInput(row: Row) {
  return {
    materialId: row.materialId,
    unitId: row.unitId,
    countedQuantity: row.countedQuantity ?? null,
    remark: row.remark ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['materialId', 'unitId', 'countedQuantity', 'remark'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy。
 *  全程收集错误文案(带行号定位,行无 idx 用表格序号),不中途抛出(同手工出入库单先例) */
async function persistItems(docId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (at: string, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${at}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyInvStockCountItem: MutationResult }>(DESTROY_ITEM, { id: old.id })
    collect(`行「${String(old.materialName ?? old.id)}」`, data.destroyInvStockCountItem.errors)
  }

  for (const [i, row] of current.entries()) {
    const at = `第${i + 1}行`
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createInvStockCountItem: MutationResult }>(CREATE_ITEM, {
        input: { countId: docId, ...itemInput(row) },
      })
      collect(at, data.createInvStockCountItem.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<{ updateInvStockCountItem: MutationResult }>(UPDATE_ITEM, {
        id: row.id,
        input: itemInput(row),
      })
      collect(at, data.updateInvStockCountItem.errors)
    }
  }
  return errors
}

function StockCountsPage() {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // edit/view 态行靠异步拉取,未完成前禁止编辑,防回填覆盖在输行(同销售订单先例)
  const [detailLoaded, setDetailLoaded] = useState(false)
  // 新建「整仓带出」开关:提交时 create 传 loadAll: true(仅 create 态展示)
  const [loadAll, setLoadAll] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号,防慢响应串单
  const reqIdRef = useRef(0)

  // 公司列表:仅一家时自动选中,并作为选择器回显数据(照仓库管理页先例)
  const companies = useQuery({
    queryKey: ['stockCountCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name } } }`
      ).then((d) => d.basCompanies),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

  const fetchItems = useCallback(async (docId: string): Promise<Row[]> => {
    const d = await gqlFetch<{ invStockCountItems: { results: Row[] } }>(FETCH_ITEMS, { docId })
    return d.invStockCountItems.results
  }, [])

  // 打开抽屉:create 行清空;view/edit 按单据 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = useCallback(
    (mode: DrawerMode, row: Row | null) => {
      const my = ++reqIdRef.current
      setDrawer({ mode, row })
      setLoadAll(false)
      if (mode === 'create') {
        setItems([])
        setItemsSnapshot([])
        setDetailLoaded(true)
        return
      }
      setDetailLoaded(false)
      fetchItems(row!.id)
        .then((rows) => {
          if (my !== reqIdRef.current) return
          setItems(rows)
          setItemsSnapshot(rows)
          setDetailLoaded(true)
        })
        .catch((e) => {
          if (my !== reqIdRef.current) return
          toast.danger('库存盘点单行加载失败', { description: (e as Error).message })
          setItems([])
          setItemsSnapshot([])
        })
    },
    [fetchItems]
  )

  const invalidateGrids = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'invStockCounts'] })
    // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
    queryClient.invalidateQueries({ queryKey: ['rowById', 'invStockCounts'] })
  }

  // 刷新账面数(仅草稿):服务端按最新余额重取全部行 book_quantity,已填实盘数保留;
  // 成功后重拉行(本地表格同步新账面)并失效单头缓存(账面快照时间)
  const refreshBook = async () => {
    const docId = drawer?.row?.id
    if (!docId) return
    setRefreshing(true)
    try {
      const data = await gqlFetch<{ refreshInvStockCount: MutationResult }>(REFRESH_DOC, { id: docId })
      const res = data.refreshInvStockCount
      if (res.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
      const rows = await fetchItems(docId)
      setItems(rows)
      setItemsSnapshot(rows)
      toast.success('账面数已刷新')
      invalidateGrids()
    } catch (e) {
      toast.danger('刷新账面数失败', { description: (e as Error).message })
    } finally {
      setRefreshing(false)
    }
  }

  // 仓候选:本公司、叶子、启用(与后端 WarehouseUsable 保存校验同口径)
  const warehouseFilter = `{companyId: {eq: ${JSON.stringify(companyId)}}, isLeaf: {eq: true}, active: {eq: true}}`

  const baseCfg = drawerConfig('invStockCounts')
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      // 公司由页面顶部选定,表单不显示,提交时注入(照仓库管理页先例)
      companyId: { ...baseCfg.fields?.companyId, visible: () => false },
      warehouseId: { ...baseCfg.fields?.warehouseId, remote: { filter: warehouseFilter } },
      postingDate: { ...baseCfg.fields?.postingDate, defaultValue: todayLocal() },
    },
  }

  // 行录入字段:物料/单位/实盘/账面半宽排布;账面数量系统取数只读,折算实盘不出表单(提交见 itemInput)
  const itemFields: Record<string, FieldOverride> = {
    materialId: {
      order: 0,
      required: true,
      // 切换物料时清掉已选单位,避免单位候选跟着旧物料走
      effects: () => ({ unitId: null }),
    },
    unitId: {
      order: 1,
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
    },
    // 实盘数量审核前可空(后端审核逐行兜底),≥0 用 minValue 与 validateItem 双保险
    countedQuantity: {
      order: 2,
      cols: 6,
      label: '实盘数量',
      input: ({ value, onChange, isDisabled }) => (
        <NumberField
          fullWidth
          minValue={0}
          isDisabled={isDisabled}
          value={value == null || value === '' ? NaN : Number(value)}
          onChange={(n) => onChange(Number.isFinite(n) ? n : null)}
        >
          <Label>实盘数量</Label>
          {/* 库样式 group 给步进按钮留列;不渲染步进按钮时改单列让 input 撑满(同表单组件先例) */}
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="审核前可空" />
          </NumberField.Group>
        </NumberField>
      ),
    },
    // 账面数量系统取数(后端 writable? false):表单只读展示存量值,新行占位提示,不录入
    bookQuantity: {
      order: 3,
      cols: 6,
      label: '账面数量',
      input: ({ value }) => (
        <NumberField fullWidth isDisabled value={value == null || value === '' ? NaN : Number(value)}>
          <Label>账面数量(物料默认单位)</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="保存后系统取数" />
          </NumberField.Group>
        </NumberField>
      ),
    },
    remark: { order: 4, label: '行备注' },
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">库存盘点单</h1>
      <p className="mt-2 text-sm text-ink-500">
        核对账实并校正库存:审核按「实盘折算 − 账面快照」差异派生库存分录(盘盈正、盘亏负),仅草稿可改可删,已审核仅可作废。
      </p>

      <div className="mt-6 max-w-xs">
        <RemoteSelect
          resource="basCompanies"
          label="公司"
          placeholder="选择公司…"
          value={companyId}
          initialRows={companyRow ? [companyRow] : (companies.data?.results ?? [])}
          onChange={(id, row) => {
            setCompanyId(id)
            setCompanyRow(row)
          }}
        />
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>库存盘点单按公司管理,选择公司后查看与新建单据。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={companyId}
            resource="invStockCounts"
            columns={GRID_COLUMNS}
            overrides={GRID_OVERRIDES}
            fixedFilter={{ companyId: { eq: companyId } }}
            defaultSort={{ column: 'postingDate', direction: 'descending' }}
            onView={(row) => openDrawer('view', row)}
            onCreate={() => openDrawer('create', null)}
            onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
            actionVisible={ACTION_VISIBLE}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="invStockCounts"
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          // 关闭即作废在途请求并清空快照,防止残留快照被下次提交按差异写误用到别的单据
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
        }}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={
          drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined
        }
        // 刷新账面数:仅草稿详情 footer(view 态无在输行,刷新后重拉不覆盖未保存修改)
        footerActions={(mode, row) =>
          mode === 'view' && row?.status === 'DRAFT' ? (
            <Button variant="secondary" isPending={refreshing} onPress={refreshBook}>
              刷新账面数
            </Button>
          ) : null
        }
        extraContent={(mode, row) => (
          <>
            {mode === 'create' && (
              <div className="mb-3">
                <Switch isSelected={loadAll} onChange={setLoadAll}>
                  <Switch.Content className="text-sm">
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    整仓带出
                  </Switch.Content>
                </Switch>
                <p className="mt-1 text-xs text-muted">
                  按该仓当前账面余额非零的物料生成盘点行;账面零的物料仍可手工加行。
                </p>
              </div>
            )}
            <SynieEditableTable
              resource="invStockCountItems"
              label="盘点行"
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)}
              // 行表单物料/单位/实盘/账面半宽排布,默认 420px 局促,加宽一档(同销售订单先例)
              drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
              exclude={[
                'countId',
                'companyId',
                // 快照列由后端保存时重拍,不进录入表单;不影响表格显示(快照经 overrides 渲染)
                'materialCode',
                'materialName',
                'materialSpec',
                'unitName',
                // 折算实盘系统算(保存后回填),不进表单;表格经「差异」计算列呈现
                'convertedCounted',
              ]}
              columns={['materialId', 'unitId', 'countedQuantity', 'bookQuantity', 'difference', 'remark']}
              overrides={{
                // 物料/单位列显示口径:行快照名(保存时落库,防主数据改名);无快照返回 undefined
                // 回落默认 fk 渲染——本地新行/编辑中刚改选的行按 join 或 id 反查显示今日名
                materialId: {
                  render: (_v, r) =>
                    r.materialName != null && r.materialName !== '' ? String(r.materialName) : undefined,
                },
                unitId: {
                  render: (_v, r) => (r.unitName != null && r.unitName !== '' ? String(r.unitName) : undefined),
                },
                countedQuantity: { label: '实盘数量' },
                bookQuantity: { label: '账面数量' },
                // 差异计算列(meta 之外,displayColumns 按 overrides 合成):实盘折算−账面,
                // 本地新行折算未回填前留空(保存后系统算),负数盘亏红字(同库存分录先例)
                difference: {
                  label: '差异',
                  align: 'end',
                  render: (_v, r) => {
                    if (r.convertedCounted == null || r.bookQuantity == null) return undefined
                    const n = Math.round((Number(r.convertedCounted) - Number(r.bookQuantity)) * 1e6) / 1e6
                    if (!Number.isFinite(n)) return undefined
                    return <span className={n < 0 ? 'text-danger' : undefined}>{n}</span>
                  },
                },
                remark: { label: '行备注' },
              }}
              fields={itemFields}
              validateItem={(vals) => {
                if (vals.countedQuantity != null && !(Number(vals.countedQuantity) >= 0))
                  return '实盘数量不能为负'
              }}
              transformItem={(values, editing) => ({
                ...values,
                // 改选物料/单位后旧快照名作废:清空让单元格回落 live 渲染,保存后后端重拍
                ...(editing != null && values.materialId !== editing.materialId ? { materialName: null } : {}),
                ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
              })}
            />
          </>
        )}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{ createInvStockCount: MutationResult }>(CREATE_DOC, {
              input: { ...values, companyId, loadAll },
            })
            const res = data.createInvStockCount
            if (res.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(res.result!.id, items, [])
            if (itemErrors.length > 0) {
              toast.danger('库存盘点单已创建,但部分盘点行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('库存盘点单已创建')
            }
          } else {
            const data = await gqlFetch<{ updateInvStockCount: MutationResult }>(UPDATE_DOC, {
              id: drawer!.row!.id,
              input: values,
            })
            const res = data.updateInvStockCount
            if (res.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(drawer!.row!.id, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('库存盘点单已更新,但部分盘点行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('库存盘点单已更新')
            }
          }
          invalidateGrids()
        }}
      />
    </>
  )
}
