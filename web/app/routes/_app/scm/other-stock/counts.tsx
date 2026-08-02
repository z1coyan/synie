import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Label, NumberField, Switch, toast } from '@heroui/react'
import { companyClient } from '~/lib/resources/companies'
import {
  refreshStockCount,
  stockCountClient,
  stockCountItemClient,
} from '~/lib/resources/inventory'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { FilterState, Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import {
  CompanyDefaultSync,
  WarehouseRemoteSelect,
  defaultCompanyId,
} from '../-stock-doc'
import { resourceBindingFor } from '~/lib/resources/registry'
import { COUNT_DOC_STATUS_ENUM_COLORS } from '~/lib/doc-status'
import { todayLocal } from '~/lib/form-defaults'
import { toastError } from '~/lib/toast'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { useRequestGuard } from '~/lib/use-request-guard'

export const Route = createFileRoute('/_app/scm/other-stock/counts')({
  component: StockCountsTab,
})

/**
 * 库存盘点单(其他库存单 → 盘点 tab):核对账实并校正库存。
 * 公司为首列可筛;建单时公司表单头字段,仓候选绑表单公司。
 */

const GRID_COLUMNS = ['companyId', 'docNo', 'postingDate', 'warehouseId', 'status', 'summary', 'auditedAt']

const GRID_OVERRIDES = {
  // 卡片:单号标题、仓库副标题、日期/状态摘要
  companyId: { mobileRole: 'hide' },
  docNo: { mobileRole: 'title' },
  warehouseId: { mobileRole: 'subtitle' },
  postingDate: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: COUNT_DOC_STATUS_ENUM_COLORS,
  },
  summary: { width: 240 },
} satisfies Record<string, ColumnOverride>

const ACTION_VISIBLE = {
  approve: (row: Row) => row.status === 'DRAFT',
  cancel: (row: Row) => row.status === 'AUDITED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

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

async function persistItems(docId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const run = async (at: string, operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      errors.push(`${at}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    await run(`行「${String(old.materialName ?? old.id)}」`, () =>
      stockCountItemClient.delete(old.id),
    )
  }

  for (const [i, row] of current.entries()) {
    const at = `第${i + 1}行`
    if (isLocalRow(row)) {
      await run(at, () => stockCountItemClient.create({ countId: docId, ...itemInput(row) }))
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      await run(at, () => stockCountItemClient.update(row.id, itemInput(row)))
    }
  }
  return errors
}

function StockCountsTab() {
  const [filters, setFilters] = useState<FilterState>({})
  // 页面级主抽屉:开/关/模式走 URL(?record=&mode=)
  const {
    drawer,
    open,
    setMode,
    close,
    row: drawerRow,
  } = useRecordDrawerUrl('invStockCounts')
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [loadAll, setLoadAll] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const queryClient = useQueryClient()
  const guard = useRequestGuard()
  // 物料选择缓存:选中整行按 id 暂存,transformItem 带出 code/name/spec 供行内物料富单元格展示
  const materialPickRef = useRef(new Map<string, Row>())
  // 已为哪张盘点单拉过明细;深链 effect 与 openDrawer 去重,避免双发
  const loadedIdRef = useRef<string | null>(null)

  const isOpen = drawer !== null
  const mode: DrawerMode = drawer?.mode ?? 'view'
  const rowId = drawer?.recordId ?? undefined
  const docStatus = drawerRow?.status

  const companies = useQuery({
    queryKey: ['stockCountCompanies'],
    queryFn: () =>
      companyClient.query({
        limit: 50,
        offset: 0,
        sort: { column: 'code', direction: 'ascending' },
      }).then((result) => result.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])

  const fetchItems = useCallback(async (docId: string): Promise<Row[]> => {
    const result = await stockCountItemClient.query({
      limit: 200,
      offset: 0,
      sort: { column: 'insertedAt', direction: 'ascending' },
      fixedFilter: {
        countId: { kind: 'fk', op: 'in', values: [docId], labels: [] },
      },
    })
    return result.results
  }, [])

  function resetDetail() {
    loadedIdRef.current = null
    setLoadAll(false)
    setItems([])
    setItemsSnapshot([])
    setDetailLoaded(true)
  }

  function loadDetail(docId: string) {
    const my = guard.begin()
    loadedIdRef.current = docId
    setLoadAll(false)
    setDetailLoaded(false)
    fetchItems(docId)
      .then((rows) => {
        if (!guard.isCurrent(my)) return
        setItems(rows)
        setItemsSnapshot(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (!guard.isCurrent(my)) return
        toastError('库存盘点单行加载失败')(e)
        setItems([])
        setItemsSnapshot([])
      })
  }

  const openDrawer = useCallback(
    (nextMode: DrawerMode, row: Row | null) => {
      open(nextMode, row?.id != null ? String(row.id) : null)
      if (nextMode === 'create' || !row) {
        resetDetail()
        return
      }
      loadDetail(String(row.id))
    },
    [fetchItems, open]
  )

  // 深链/前进后退:URL 驱动打开时 openDrawer 未走,按 recordId 补拉明细
  useEffect(() => {
    const d = drawer
    if (!d) {
      if (loadedIdRef.current != null) {
        guard.invalidate()
        resetDetail()
      }
      return
    }
    if (d.mode === 'create' || d.recordId == null) {
      if (loadedIdRef.current != null) resetDetail()
      return
    }
    if (loadedIdRef.current !== d.recordId) {
      loadDetail(d.recordId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 URL 抽屉身份变化时响应
  }, [drawer?.recordId, drawer?.mode])

  const invalidateGrids = () => {
    void resourceBindingFor('invStockCounts').cache.invalidateAll(queryClient)
  }

  const refreshBook = async () => {
    const docId = rowId
    if (!docId) return
    setRefreshing(true)
    try {
      await refreshStockCount(docId)
      const rows = await fetchItems(docId)
      setItems(rows)
      setItemsSnapshot(rows)
      toast.success('账面数已刷新')
      invalidateGrids()
    } catch (e) {
      toastError('刷新账面数失败')(e)
    } finally {
      setRefreshing(false)
    }
  }

  const baseCfg = drawerConfig('invStockCounts')
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
      postingDate: { ...baseCfg.fields?.postingDate, defaultValue: todayLocal() },
    },
  }

  const itemFields: Record<string, FieldOverride> = {
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
          <NumberField.Group className="grid-cols-[1fr]">
            <NumberField.Input placeholder="审核前可空" />
          </NumberField.Group>
        </NumberField>
      ),
    },
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
      <p className="mb-4 text-sm text-ink-500">
        核对账实并校正库存:审核按「实盘折算 − 账面快照」差异派生库存分录(盘盈正、盘亏负),仅草稿可改可删,已审核仅可作废。
      </p>

      <SynieDataGrid
        resource="invStockCounts"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'postingDate', direction: 'descending' }}
        createLabel="新建盘点单"
        onFiltersChange={setFilters}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
        actionVisible={ACTION_VISIBLE}
      />

      <SynieRecordDrawer
        resource="invStockCounts"
        {...drawerCfg}
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(isDrawerOpen) => {
          if (isDrawerOpen) return
          guard.invalidate()
          close()
          setItems([])
          setItemsSnapshot([])
          loadedIdRef.current = null
        }}
        rowId={rowId}
        onEdit={
          docStatus === 'DRAFT' ? () => setMode('edit') : undefined
        }
        footerActions={(mode, row) =>
          mode === 'view' && row?.status === 'DRAFT' ? (
            <Button variant="secondary" isPending={refreshing} onPress={refreshBook}>
              刷新账面数
            </Button>
          ) : null
        }
        extraContent={(mode, row, values, patchValues) => (
          <>
            <CompanyDefaultSync
              mode={mode}
              values={values}
              patchValues={patchValues}
              defaultId={createDefaultCompany}
            />
            {mode === 'create' && (
              <div className="mb-3">
                <Switch
                  isSelected={loadAll}
                  onChange={(selected) => {
                    setLoadAll(selected)
                    if (selected) setItems([])
                  }}
                >
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
              readOnly={
                mode === 'view' ||
                (mode === 'create' && loadAll) ||
                (row != null && row.status !== 'DRAFT') ||
                (mode !== 'create' && !detailLoaded)
              }
              drawerClassName="w-full lg:w-[560px]"
              exclude={[
                'countId',
                'companyId',
                'materialCode',
                'materialName',
                'materialSpec',
                'unitName',
                'convertedCounted',
              ]}
              columns={['materialId', 'unitId', 'countedQuantity', 'bookQuantity', 'difference', 'remark']}
              overrides={{
                // 物料列:全站统一富单元格(图纸缩略图+快照字段,编号点开物料速览);
                // 库存类行无图纸挂接,缩略图回退物料当前图纸
                materialId: { render: materialCellRender() },
                unitId: {
                  render: (_v, r) => (r.unitName != null && r.unitName !== '' ? String(r.unitName) : undefined),
                },
                countedQuantity: { label: '实盘数量' },
                bookQuantity: { label: '账面数量' },
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
              transformItem={(values, editing) => {
                // 改选物料/单位后旧快照名作废(mergeItem 清旧 join 同理);新选物料从选择缓存带出
                // code/name/spec,本地新行的物料富单元格即时可见(保存后后端重拍快照)
                const picked =
                  values.materialId != null
                    ? materialPickRef.current.get(String(values.materialId))
                    : undefined
                return {
                  ...values,
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
          if (mode === 'create') {
            await stockCountClient.create({
              ...values,
              loadAll,
              items: loadAll ? undefined : items.map(itemInput),
            })
            toast.success('库存盘点单已创建')
          } else {
            await stockCountClient.update(rowId!, values)
            const itemErrors = await persistItems(rowId!, items, itemsSnapshot)
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
