import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, toast } from '@heroui/react'
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

/**
 * 手工出入库单页面实现(原入库单/出库单两页合一:头=公司+方向+仓+业务日期+摘要+备注,
 * 行=物料+单位+录入数量+折算数量+行备注;草稿→已审核→(已作废),仅草稿可改可删,
 * 方向创建后锁死,见 ADR 2026-07-19-stock-ledger)。
 * 页面形态照仓库管理页:顶部公司选择器(仅列已授权公司,后端 CompanyScope 兜底)+ 按公司过滤的
 * 单据 grid + 三态抽屉(头字段 + SynieEditableTable 行表,行随父表单提交一并持久化)。
 * 审核/作废走后端 grid_actions 内建行操作(带确认),按行状态显隐;折算数量 baseQty 后端系统算,
 * 行表单只读占位、行表格展示。
 */

export interface StockDocConfig {
  /** 头资源(GridMeta 白名单名):invStockDocs */
  resource: string
  /** 行资源:invStockDocItems */
  itemResource: string
  /** 单据中文名:页面标题/抽屉标题 */
  label: string
  /** 行中文名:行表新增按钮/二级抽屉标题 */
  itemLabel: string
  /** 页面副文 */
  description: string
  /** 行上指向头的 fk 字段(camel):stockDocId */
  docIdField: string
  /** 行查询名(GraphQL list):invStockDocItems */
  itemQuery: string
  mutations: {
    createDoc: string
    updateDoc: string
    createItem: string
    updateItem: string
    destroyItem: string
  }
  resultKeys: {
    createDoc: string
    updateDoc: string
    createItem: string
    updateItem: string
    destroyItem: string
  }
  /** 摘要占位(「货从哪来/到哪去」) */
  summaryPlaceholder: string
}

// 列表列白名单:公司由页面顶部选定不进列,录入人/审核人/时间戳不进表格(兼当 exclude);
// direction 枚举列自带选项筛选(入库/出库)
const GRID_COLUMNS = ['docNo', 'direction', 'docDate', 'warehouseId', 'status', 'summary', 'auditedAt']

// 状态胶囊配色:草稿灰、已审核绿、已作废红(同销售订单先例)
const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
  summary: { width: 240 },
} satisfies Record<string, ColumnOverride>

// 状态机动作显隐:审核/删除仅草稿,作废仅已审核(后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
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

// mutation input 只收行自身字段:baseQty 系统算(writable? false)、companyId 冗余自母单(后端回填)、
// 快照字段(materialName/unitName 等)由后端保存时重拍;本地草稿 id 与行上挂的 join 对象不进 payload
function itemInput(row: Row) {
  return {
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    remark: row.remark ?? null,
  }
}

const ITEM_COMPARE_KEYS = ['idx', 'materialId', 'unitId', 'qty', 'remark'] as const

function itemChanged(before: Row, after: Row): boolean {
  return ITEM_COMPARE_KEYS.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy。
 *  全程收集错误文案(带行号定位),不中途抛出(同销售订单条目先例) */
async function persistItems(cfg: StockDocConfig, docId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (idx: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `第${idx}行:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<Record<string, MutationResult>>(cfg.mutations.destroyItem, { id: old.id })
    collect(old.idx, data[cfg.resultKeys.destroyItem]?.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<Record<string, MutationResult>>(cfg.mutations.createItem, {
        input: { [cfg.docIdField]: docId, ...itemInput(row) },
      })
      collect(row.idx, data[cfg.resultKeys.createItem]?.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      const data = await gqlFetch<Record<string, MutationResult>>(cfg.mutations.updateItem, {
        id: row.id,
        input: itemInput(row),
      })
      collect(row.idx, data[cfg.resultKeys.updateItem]?.errors)
    }
  }
  return errors
}

export function StockDocPage({ cfg }: { cfg: StockDocConfig }) {
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  // edit/view 态行靠异步拉取,未完成前禁止编辑,防回填覆盖在输行(同销售订单先例)
  const [detailLoaded, setDetailLoaded] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:每次开/关抽屉自增,异步回填前比对最新序号,防慢响应串单
  const reqIdRef = useRef(0)

  // 公司列表:仅一家时自动选中,并作为选择器回显数据(照仓库管理页先例)
  const companies = useQuery({
    queryKey: [cfg.resource, 'companies'],
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

  // 打开抽屉:create 行清空;view/edit 按单据 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = useCallback(
    (mode: DrawerMode, row: Row | null) => {
      const my = ++reqIdRef.current
      setDrawer({ mode, row })
      if (mode === 'create') {
        setItems([])
        setItemsSnapshot([])
        setDetailLoaded(true)
        return
      }
      setDetailLoaded(false)
      const FETCH_ITEMS = `
        query ($docId: ID!) {
          ${cfg.itemQuery}(filter: {${cfg.docIdField}: {eq: $docId}}, sort: [{field: IDX, order: ASC}], limit: 200, offset: 0) {
            results { id idx materialId unitId qty baseQty remark materialName unitName material { id name } unit { id name } }
          }
        }
      `
      gqlFetch<Record<string, { results: Row[] }>>(FETCH_ITEMS, { docId: row!.id })
        .then((d) => {
          if (my !== reqIdRef.current) return
          const rows = d[cfg.itemQuery].results
          setItems(rows)
          setItemsSnapshot(rows)
          setDetailLoaded(true)
        })
        .catch((e) => {
          if (my !== reqIdRef.current) return
          toast.danger(`${cfg.label}行加载失败`, { description: (e as Error).message })
          setItems([])
          setItemsSnapshot([])
        })
    },
    [cfg]
  )

  // 仓候选:本公司、叶子、启用(与后端 WarehouseUsable 保存校验同口径)
  const warehouseFilter = `{companyId: {eq: ${JSON.stringify(companyId)}}, isLeaf: {eq: true}, active: {eq: true}}`

  const baseCfg = drawerConfig(cfg.resource)
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      // 公司由页面顶部选定,表单不显示,提交时注入(照仓库管理页先例)
      companyId: { ...baseCfg.fields?.companyId, visible: () => false },
      warehouseId: { ...baseCfg.fields?.warehouseId, remote: { filter: warehouseFilter } },
      docDate: { ...baseCfg.fields?.docDate, defaultValue: todayLocal() },
      summary: { ...baseCfg.fields?.summary, placeholder: cfg.summaryPlaceholder },
    },
  }

  // 行录入字段:物料/单位/数量半宽排布;折算数量只读(后端按物料默认单位系统算)
  const itemFields: Record<string, FieldOverride> = {
    // 行号系统自动分配(transformItem),表格照常展示
    idx: { visible: () => false },
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
    qty: { order: 2, cols: 6, required: true, label: '数量' },
    // 折算数量系统算(后端 writable? false):表单只读展示存量值,新行占位提示,不录入(提交见 itemInput)
    baseQty: {
      order: 3,
      cols: 6,
      label: '折算数量',
      input: ({ value }) => (
        <NumberField fullWidth isDisabled value={value == null || value === '' ? NaN : Number(value)}>
          <Label>折算数量(物料默认单位)</Label>
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="保存后系统折算" />
          </NumberField.Group>
        </NumberField>
      ),
    },
    remark: { order: 4, label: '行备注' },
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">{cfg.label}</h1>
      <p className="mt-2 text-sm text-ink-500">{cfg.description}</p>

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
              <EmptyState.Description>{cfg.label}按公司管理,选择公司后查看与新建单据。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <SynieDataGrid
            key={companyId}
            resource={cfg.resource}
            columns={GRID_COLUMNS}
            overrides={GRID_OVERRIDES}
            fixedFilter={{ companyId: { eq: companyId } }}
            defaultSort={{ column: 'docDate', direction: 'descending' }}
            onView={(row) => openDrawer('view', row)}
            onCreate={() => openDrawer('create', null)}
            onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
            actionVisible={ACTION_VISIBLE}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource={cfg.resource}
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
        extraContent={(mode, row) => (
          <SynieEditableTable
            resource={cfg.itemResource}
            label={cfg.itemLabel}
            items={items}
            onChange={setItems}
            readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)}
            // 行表单物料/单位/数量半宽排布,默认 420px 局促,加宽一档(同销售订单先例)
            drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
            exclude={[
              cfg.docIdField,
              'companyId',
              // 快照列由后端保存时重拍,不进录入表单;不影响表格显示(快照经 overrides 渲染)
              'materialCode',
              'materialName',
              'materialSpec',
              'unitName',
            ]}
            columns={['idx', 'materialId', 'unitId', 'qty', 'baseQty', 'remark']}
            overrides={{
              // 物料/单位列显示口径:行快照名(保存时落库,防主数据改名);无快照返回 undefined
              // 回落默认 fk 渲染——本地新行/编辑中刚改选的行按 join 或 id 反查显示今日名
              materialId: {
                render: (_v, r) => (r.materialName != null && r.materialName !== '' ? String(r.materialName) : undefined),
              },
              unitId: {
                render: (_v, r) => (r.unitName != null && r.unitName !== '' ? String(r.unitName) : undefined),
              },
              baseQty: { label: '折算数量' },
              remark: { label: '行备注' },
            }}
            fields={itemFields}
            validateItem={(vals) => {
              if (!(Number(vals.qty) > 0)) return '数量必须大于零'
            }}
            transformItem={(values, editing) => ({
              ...values,
              // 行号自动:存量行保号,新行取当前最大 idx+1(而非 length+1,避免删行后撞号)
              idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
              // 改选物料/单位后旧快照名作废:清空让单元格回落 live 渲染,保存后后端重拍
              ...(editing != null && values.materialId !== editing.materialId ? { materialName: null } : {}),
              ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
            })}
          />
        )}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<Record<string, MutationResult>>(cfg.mutations.createDoc, {
              input: { ...values, companyId },
            })
            const res = data[cfg.resultKeys.createDoc]
            if (res?.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
            const docId = res!.result!.id
            const itemErrors = await persistItems(cfg, docId, items, [])
            if (itemErrors.length > 0) {
              toast.danger(`${cfg.label}已创建,但部分单据行保存失败`, { description: itemErrors.join('; ') })
            } else {
              toast.success(`${cfg.label}已创建`)
            }
          } else {
            const data = await gqlFetch<Record<string, MutationResult>>(cfg.mutations.updateDoc, {
              id: drawer!.row!.id,
              input: values,
            })
            const res = data[cfg.resultKeys.updateDoc]
            if (res?.errors && res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '))
            const itemErrors = await persistItems(cfg, drawer!.row!.id, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger(`${cfg.label}已更新,但部分单据行保存失败`, { description: itemErrors.join('; ') })
            } else {
              toast.success(`${cfg.label}已更新`)
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', cfg.resource] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', cfg.resource] })
        }}
      />
    </>
  )
}
