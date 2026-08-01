import { useCallback, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Label, NumberField, toast } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import {
  CompanyDefaultSync,
  defaultCompanyId,
  todayLocal,
} from '~/lib/form-defaults'
import { companyClient } from '~/lib/resources/companies'
import {
  assertAggregateDraftReady,
  submitAggregateDraft,
} from '~/lib/resources/aggregate-draft-submit'
import {
  aggregateDraftRows,
  stockMovementDraftRow,
} from '~/lib/resources/aggregate-draft-rows'
import { aggregateDraftFor, resourceBindingFor } from '~/lib/resources/registry'

export { CompanyDefaultSync, defaultCompanyId, todayLocal }

/**
 * 手工出入库单页面实现(其他库存单 → 出入库 tab)。
 * 列表公司为首列可筛(无顶部全局公司);建单时公司为表单头必填(createOnly),
 * 默认值:列筛唯一公司 → 授权列表第一家 → 空。仓候选绑表单当前公司。
 */

export interface StockDocConfig {
  /** 头资源(GridMeta 白名单名):invStockDocs */
  resource: 'invStockDocs'
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
  /** 摘要占位(「货从哪来/到哪去」) */
  summaryPlaceholder: string
}

const stockDocDraft = aggregateDraftFor('invStockDocs')

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
  // 卡片:单号标题、仓库副标题、方向/日期/状态摘要
  companyId: { mobileRole: 'hide' },
  docNo: { mobileRole: 'title' },
  warehouseId: { mobileRole: 'subtitle' },
  direction: { mobileRole: 'summary' },
  docDate: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' },
  },
  summary: { width: 240 },
} satisfies Record<string, ColumnOverride>

const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

/** 本公司启用叶子仓的结构化筛选；未选公司时不发起候选查询。 */
export function warehouseFilterState(companyId: string | null): FilterState | undefined {
  if (companyId == null || companyId === '') return undefined
  return {
    companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
    isLeaf: { kind: 'bool', eq: true },
    active: { kind: 'bool', eq: true },
  }
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
      filterState={warehouseFilterState(companyId)}
    />
  )
}

export function StockDocPage({ cfg }: { cfg: StockDocConfig }) {
  const [filters, setFilters] = useState<FilterState>({})
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)
  // 物料选择缓存:选中整行按 id 暂存,transformItem 带出 code/name/spec 供行内物料富单元格展示
  const materialPickRef = useRef(new Map<string, Row>())

  const companies = useQuery({
    queryKey: [cfg.resource, 'companies'],
    queryFn: () =>
      companyClient.query({
        limit: 50,
        offset: 0,
        sort: { column: 'code', direction: 'ascending' },
      }).then((result) => result.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const openDrawer = useCallback((mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create') {
      setItems([])
      setDetailLoaded(true)
      return
    }
    setDetailLoaded(false)
    stockDocDraft
      .loadDraft(row!.id)
      .then((saved) => {
        if (my !== reqIdRef.current) return
        const rows = aggregateDraftRows(saved, 'items', cfg.label)
        setItems(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger(`${cfg.label}行加载失败`, { description: (e as Error).message })
        setItems([])
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
      effects: (_value, selectedRow) => {
        if (selectedRow) materialPickRef.current.set(String(selectedRow.id), selectedRow)
        return { unitId: null }
      },
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
                // 物料列:全站统一富单元格(图纸缩略图+快照字段,编号点开物料速览);
                // 库存类行无图纸挂接,缩略图回退物料当前图纸
                materialId: { render: materialCellRender() },
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
              transformItem={(values, editing) => {
                // 改选物料/单位后旧快照名作废(mergeItem 清旧 join 同理);新选物料从选择缓存带出
                // code/name/spec,本地新行的物料富单元格即时可见(保存后后端重拍快照)
                const picked =
                  values.materialId != null
                    ? materialPickRef.current.get(String(values.materialId))
                    : undefined
                return {
                  ...values,
                  idx: editing ? editing.idx : items.reduce((max, r) => Math.max(max, Number(r.idx) || 0), 0) + 1,
                  ...(editing != null && values.materialId !== editing.materialId
                    ? { materialCode: null, materialName: null, materialSpec: null }
                    : {}),
                  ...(picked != null
                    ? {
                        materialCode: picked.code ?? null,
                        materialName: picked.name ?? null,
                        materialSpec: picked.spec ?? null,
                      }
                    : {}),
                  ...(editing != null && values.unitId !== editing.unitId ? { unitName: null } : {}),
                }
              }}
            />
          </>
        )}
        onSubmit={async (values, mode) => {
          assertAggregateDraftReady(mode, detailLoaded, `${cfg.label}行`)
          const input = { ...values, items: items.map(stockMovementDraftRow) }
          const savedId = await submitAggregateDraft(
            stockDocDraft,
            mode,
            drawer?.row?.id,
            input,
            cfg.label,
          )
          toast.success(`${cfg.label}已${mode === 'create' ? '创建' : '更新'}`)
          await Promise.all([
            resourceBindingFor(cfg.resource).cache.invalidateAll(queryClient),
            resourceBindingFor(cfg.itemResource).cache.invalidateAll(queryClient),
          ])
          return savedId
        }}
      />
    </>
  )
}
