import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'

/**
 * 手工出入库单页面实现(其他库存单 → 出入库 tab)。
 * 列表公司为首列可筛(无顶部全局公司);建单时公司为表单头必填(createOnly),
 * 默认值:列筛唯一公司 → 唯一授权公司 → 空。仓候选绑表单当前公司。
 */

export interface StockDocConfig {
  /** 头资源(GridMeta 白名单名):invStockDocs */
  resource: string
  /** 行资源:invStockDocItems */
  itemResource: string
  /** 单据中文名:抽屉标题/toast */
  label: string
  /** 行中文名:行表新增按钮/二级抽屉标题 */
  itemLabel: string
  /** tab 内小号业务说明 */
  description: string
  /** 新建按钮文案 */
  createLabel: string
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

// 列表列:公司首列(对齐总账分录/会计凭证);录入人/审核人/时间戳不进表格
const GRID_COLUMNS = [
  'companyId',
  'docNo',
  'direction',
  'docDate',
  'warehouseId',
  'status',
  'summary',
  'auditedAt',
]

const GRID_OVERRIDES = {
  status: { enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' } },
  summary: { width: 240 },
} satisfies Record<string, ColumnOverride>

const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 新建公司默认:列筛恰好 1 家 → 唯一授权公司 → 空 */
export function defaultCompanyId(filters: FilterState, companies: Row[]): string | null {
  const f = filters.companyId
  if (f?.kind === 'fk' && f.values.length === 1) return f.values[0]
  if (companies.length === 1) return companies[0].id
  return null
}

/** 本公司启用叶子仓 filter 字面量;未选公司返回 null(禁用选择器) */
export function warehouseFilterLiteral(companyId: string | null): string | undefined {
  if (companyId == null || companyId === '') return undefined
  return `{companyId: {eq: ${JSON.stringify(companyId)}}, isLeaf: {eq: true}, active: {eq: true}}`
}

/** 仓 RemoteSelect:候选绑表单公司,未选公司禁用 */
export function WarehouseRemoteSelect({
  value,
  onChange,
  isDisabled,
  companyId,
  label = '仓库',
}: {
  value: unknown
  onChange: (v: unknown) => void
  isDisabled: boolean
  companyId: string | null
  label?: string
}) {
  return (
    <RemoteSelect
      resource="invWarehouses"
      label={label}
      placeholder={companyId ? `选择${label}…` : '先选择公司'}
      value={value == null || value === '' ? null : String(value)}
      onChange={(id) => onChange(id)}
      isDisabled={isDisabled || companyId == null}
      filter={warehouseFilterLiteral(companyId)}
    />
  )
}

/**
 * create 态公司默认值回填(列筛/唯一授权公司):表单 defaultValue 只在挂载时读一次,
 * 公司列表异步到达后由本组件补丁写入。
 */
export function CompanyDefaultSync({
  mode,
  values,
  patchValues,
  defaultId,
}: {
  mode: DrawerMode
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
  defaultId: string | null
}) {
  useEffect(() => {
    if (mode !== 'create' || defaultId == null) return
    if (values.companyId != null && values.companyId !== '') return
    patchValues({ companyId: defaultId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, defaultId, values.companyId])
  return null
}

interface MutationResult {
  result?: { id: string } | null
  errors: { message: string }[] | null
}

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
  const [filters, setFilters] = useState<FilterState>({})
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const companies = useQuery({
    queryKey: [cfg.resource, 'companies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name } } }`
      ).then((d) => d.basCompanies.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const openDrawer = useCallback((mode: DrawerMode, row: Row | null) => {
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
  }, [cfg])

  const baseCfg = drawerConfig(cfg.resource)
  const drawerCfg = {
    ...baseCfg,
    fields: {
      ...baseCfg.fields,
      // 公司:建后不可换;换公司清仓;默认值由 CompanyDefaultSync / defaultValue 写入
      companyId: {
        ...baseCfg.fields?.companyId,
        required: true,
        order: -1,
        edit: 'createOnly' as const,
        defaultValue: createDefaultCompany,
        effects: () => ({ warehouseId: null }),
      },
      warehouseId: {
        ...baseCfg.fields?.warehouseId,
        required: true,
        input: ({ value, onChange, isDisabled, values }: {
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
          />
        ),
      },
      docDate: { ...baseCfg.fields?.docDate, defaultValue: todayLocal() },
      summary: { ...baseCfg.fields?.summary, placeholder: cfg.summaryPlaceholder },
    },
  }

  const itemFields: Record<string, FieldOverride> = {
    idx: { visible: () => false },
    materialId: {
      order: 0,
      required: true,
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
      <p className="mb-4 text-sm text-ink-500">{cfg.description}</p>

      <SynieDataGrid
        resource={cfg.resource}
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'docDate', direction: 'descending' }}
        createLabel={cfg.createLabel}
        onFiltersChange={setFilters}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
        actionVisible={ACTION_VISIBLE}
      />

      <SynieRecordDrawer
        resource={cfg.resource}
        {...drawerCfg}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (open) return
          reqIdRef.current++
          setDrawer(null)
          setItems([])
          setItemsSnapshot([])
        }}
        rowId={drawer?.row?.id}
        onEdit={
          drawer?.row?.status === 'DRAFT' ? () => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d)) : undefined
        }
        extraContent={(mode, row, values, patchValues) => (
          <>
            <CompanyDefaultSync
              mode={mode}
              values={values}
              patchValues={patchValues}
              defaultId={createDefaultCompany}
            />
            <SynieEditableTable
              resource={cfg.itemResource}
              label={cfg.itemLabel}
              items={items}
              onChange={setItems}
              readOnly={mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)}
              drawerProps={{ contentClassName: 'w-full lg:w-[560px]' }}
              exclude={[
                cfg.docIdField,
                'companyId',
                'materialCode',
                'materialName',
                'materialSpec',
                'unitName',
              ]}
              columns={['idx', 'materialId', 'unitId', 'qty', 'baseQty', 'remark']}
              overrides={{
                materialId: {
                  render: (_v, r) =>
                    r.materialName != null && r.materialName !== '' ? String(r.materialName) : undefined,
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
                idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                ...(editing != null && values.materialId !== editing.materialId ? { materialName: null } : {}),
                ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
              })}
            />
          </>
        )}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const data = await gqlFetch<Record<string, MutationResult>>(cfg.mutations.createDoc, {
              input: values,
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
            savedId = docId
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
            savedId = drawer!.row!.id
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', cfg.resource] })
          queryClient.invalidateQueries({ queryKey: ['rowById', cfg.resource] })
          return savedId
        }}
      />
    </>
  )
}
