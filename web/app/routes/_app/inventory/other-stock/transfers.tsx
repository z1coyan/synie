import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, Label, NumberField, Spinner, toast } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { companyClient } from '~/lib/resources/companies'
import {
  stockTransferClient,
  stockTransferItemClient,
  warehouseClient,
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
} from '../../scm/-stock-doc'
import { executeCommandWithInvalidation } from '~/lib/resources/command-invalidation'
import { resourceBindingFor } from '~/lib/resources/registry'
import { TRANSFER_DOC_STATUS_ENUM_COLORS } from '~/lib/doc-status'
import { todayLocal } from '~/lib/form-defaults'
import { toastError } from '~/lib/toast'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { useRequestGuard } from '~/lib/use-request-guard'

export const Route = createFileRoute('/_app/inventory/other-stock/transfers')({
  component: StockTransfersTab,
})

/**
 * 手工调拨单(其他库存单 → 调拨 tab):同公司三仓走在途,一单两动作。
 * 公司为首列可筛;建单时公司表单头字段,仓候选绑表单公司;在途仓预填种子仓。
 */

const GRID_COLUMNS = [
  'companyId',
  'docNo',
  'docDate',
  'fromWarehouseId',
  'toWarehouseId',
  'transitWarehouseId',
  'status',
  'summary',
]

const GRID_OVERRIDES = {
  // 卡片:单号标题、调出仓副标题、调入仓/日期/状态摘要
  companyId: { mobileRole: 'hide' },
  docNo: { mobileRole: 'title' },
  fromWarehouseId: { mobileRole: 'subtitle' },
  toWarehouseId: { mobileRole: 'summary' },
  docDate: { mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: TRANSFER_DOC_STATUS_ENUM_COLORS,
  },
  summary: { width: 200 },
} satisfies Record<string, ColumnOverride>

const ACTION_VISIBLE = {
  ship: (row: Row) => row.status === 'DRAFT',
  receive: (row: Row) => row.status === 'SHIPPED',
  edit: (row: Row) => row.status === 'DRAFT',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

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

async function persistItems(docId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const run = async (idx: unknown, operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      errors.push(`第${idx}行:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    await run(old.idx, () => stockTransferItemClient.delete(old.id))
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      await run(row.idx, () =>
        stockTransferItemClient.create({ stockTransferId: docId, ...itemInput(row) }),
      )
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && itemChanged(old, row)) {
      await run(row.idx, () => stockTransferItemClient.update(row.id, itemInput(row)))
    }
  }
  return errors
}

/** create 态按公司查叶子仓,命中种子名「{公司编号} - 在途」且在途仓未填时预填 */
function TransitWarehouseSync({
  mode,
  companyId,
  companyCode,
  values,
  patchValues,
}: {
  mode: DrawerMode
  companyId: string | null
  companyCode: string | null
  values: Record<string, unknown>
  patchValues: (patch: Record<string, unknown>) => void
}) {
  const query = useQuery({
    queryKey: ['transitWarehouse', warehouseClient.id, companyId, companyCode],
    enabled: mode === 'create' && companyId != null && companyCode != null,
    staleTime: 300_000,
    queryFn: () =>
      warehouseClient
        .query({
          limit: 200,
          offset: 0,
          filter: {
            companyId: { kind: 'fk', op: 'in', values: [companyId!], labels: [] },
            isLeaf: { kind: 'bool', eq: true },
          },
        })
        .then((result) =>
          result.results.find((warehouse) => warehouse.name === String(companyCode) + ' - 在途')?.id ?? null,
        ),
  })
  const found = query.data ?? null
  const current = values.transitWarehouseId

  useEffect(() => {
    if (mode !== 'create' || found == null) return
    if (current == null || current === '') patchValues({ transitWarehouseId: found })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, found, current])

  return null
}

function StockTransfersTab() {
  const [filters, setFilters] = useState<FilterState>({})
  // 页面级主抽屉:开/关/模式走 URL(?record=&mode=)
  const {
    drawer,
    open,
    setMode,
    close,
    row: drawerRow,
  } = useRecordDrawerUrl('invStockTransfers')
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const [detailLoaded, setDetailLoaded] = useState(false)
  const [receiveDoc, setReceiveDoc] = useState<Row | null>(null)
  const [receipts, setReceipts] = useState<Record<string, number>>({})
  const [receiving, setReceiving] = useState(false)
  const queryClient = useQueryClient()
  const guard = useRequestGuard()
  // 物料选择缓存:选中整行按 id 暂存,transformItem 带出 code/name/spec 供行内物料富单元格展示
  const materialPickRef = useRef(new Map<string, Row>())
  // 已为哪张调拨单拉过明细;深链 effect 与 openDrawer 去重,避免双发
  const loadedIdRef = useRef<string | null>(null)

  const isOpen = drawer !== null
  const mode: DrawerMode = drawer?.mode ?? 'view'
  const rowId = drawer?.recordId ?? undefined
  const docStatus = drawerRow?.status

  // code 用于在途仓种子名匹配
  const companies = useQuery({
    queryKey: ['stockTransferCompanies'],
    queryFn: () =>
      companyClient.query({
        limit: 50,
        offset: 0,
        sort: { column: 'code', direction: 'ascending' },
      }).then((result) => result.results),
  })

  const createDefaultCompany = defaultCompanyId(filters, companies.data ?? [])
  const codeById = new Map((companies.data ?? []).map((c) => [c.id, String(c.code ?? '')]))

  function resetDetail() {
    loadedIdRef.current = null
    setItems([])
    setItemsSnapshot([])
    setDetailLoaded(true)
  }

  function loadDetail(docId: string) {
    const my = guard.begin()
    loadedIdRef.current = docId
    setDetailLoaded(false)
    stockTransferItemClient
      .query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        fixedFilter: {
          stockTransferId: { kind: 'fk', op: 'in', values: [docId], labels: [] },
        },
      })
      .then((result) => {
        if (!guard.isCurrent(my)) return
        const rows = result.results
        setItems(rows)
        setItemsSnapshot(rows)
        setDetailLoaded(true)
      })
      .catch((e) => {
        if (!guard.isCurrent(my)) return
        toastError('调拨单行加载失败')(e)
        setItems([])
        setItemsSnapshot([])
      })
  }

  const openDrawer = useCallback((nextMode: DrawerMode, row: Row | null) => {
    open(nextMode, row?.id != null ? String(row.id) : null)
    if (nextMode === 'create' || !row) {
      resetDetail()
      return
    }
    loadDetail(String(row.id))
  }, [open])

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

  const receiveItems = useQuery({
    queryKey: ['transferReceiveItems', receiveDoc?.id],
    enabled: receiveDoc != null,
    queryFn: () =>
      stockTransferItemClient.query({
        limit: 200,
        offset: 0,
        sort: { column: 'idx', direction: 'ascending' },
        fixedFilter: {
          stockTransferId: { kind: 'fk', op: 'in', values: [receiveDoc!.id], labels: [] },
        },
      }).then((result) => result.results),
  })

  useEffect(() => {
    if (receiveItems.data) {
      setReceipts(Object.fromEntries(receiveItems.data.map((r) => [r.id, Number(r.baseQty)])))
    }
  }, [receiveItems.data])

  const invalidateGrids = () => {
    void resourceBindingFor('invStockTransfers').cache.invalidateAll(queryClient)
  }

  const submitReceive = async () => {
    if (!receiveDoc || !receiveItems.data) return
    setReceiving(true)
    try {
      const input = {
        receipts: receiveItems.data.map((r) => ({
          itemId: r.id,
          qty: String(Number.isFinite(receipts[r.id]) ? receipts[r.id] : 0),
        })),
      }
      await executeCommandWithInvalidation(
        resourceBindingFor('invStockTransfers'),
        'receive',
        { id: receiveDoc.id, ...input },
        queryClient,
      )
      toast.success('调拨单已收货')
      setReceiveDoc(null)
    } catch (e) {
      toastError('收货失败')(e)
    } finally {
      setReceiving(false)
    }
  }

  const baseCfg = drawerConfig('invStockTransfers')
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
        effects: () => ({
          fromWarehouseId: null,
          toWarehouseId: null,
          transitWarehouseId: null,
        }),
      },
      fromWarehouseId: {
        ...baseCfg.fields?.fromWarehouseId,
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
            label="调出仓库"
          />
        ),
      },
      toWarehouseId: {
        ...baseCfg.fields?.toWarehouseId,
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
            label="调入仓库"
          />
        ),
      },
      transitWarehouseId: {
        ...baseCfg.fields?.transitWarehouseId,
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
            label="在途仓库"
          />
        ),
      },
      docDate: { ...baseCfg.fields?.docDate, defaultValue: todayLocal() },
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
    receivedQty: { visible: () => false },
    remark: { order: 4, label: '行备注' },
  }

  return (
    <>
      <p className="mb-4 text-sm text-ink-500">
        同公司三仓(调出/调入/在途)间的库存移动:发货后货在在途仓,收货按行确认实收,差额留在在途仓由手工出入库单(出库)清理。
      </p>

      <SynieDataGrid
        resource="invStockTransfers"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        defaultSort={{ column: 'docDate', direction: 'descending' }}
        createLabel="新建调拨单"
        onFiltersChange={setFilters}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
        actionVisible={ACTION_VISIBLE}
        actionHandlers={{ receive: (rows) => setReceiveDoc(rows[0]) }}
      />

      <SynieRecordDrawer
        resource="invStockTransfers"
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
        extraContent={(mode, row, values, patchValues) => {
          const formCompanyId = (values.companyId as string | null) ?? null
          return (
            <>
              <CompanyDefaultSync
                mode={mode}
                values={values}
                patchValues={patchValues}
                defaultId={createDefaultCompany}
              />
              <TransitWarehouseSync
                mode={mode}
                companyId={formCompanyId}
                companyCode={formCompanyId ? (codeById.get(formCompanyId) ?? null) : null}
                values={values}
                patchValues={patchValues}
              />
              <SynieEditableTable
                resource="invStockTransferItems"
                label="调拨行"
                items={items}
                onChange={setItems}
                readOnly={
                  mode === 'view' || (row != null && row.status !== 'DRAFT') || (mode !== 'create' && !detailLoaded)
                }
                drawerClassName="w-full lg:w-[560px]"
                exclude={[
                  'stockTransferId',
                  'companyId',
                  'materialCode',
                  'materialName',
                  'materialSpec',
                  'unitName',
                ]}
                columns={['idx', 'materialId', 'unitId', 'qty', 'baseQty', 'receivedQty', 'remark']}
                overrides={{
                  // 物料列:全站统一富单元格(图纸缩略图+快照字段,编号点开物料速览);
                  // 库存类行无图纸挂接,缩略图回退物料当前图纸
                  materialId: { render: materialCellRender() },
                  unitId: {
                    render: (_v, r) =>
                      r.unitName != null && r.unitName !== '' ? String(r.unitName) : undefined,
                  },
                  baseQty: { label: '折算数量' },
                  receivedQty: { label: '实收数量' },
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
          )
        }}
        onSubmit={async (values, mode) => {
          const warehouses = [values.fromWarehouseId, values.toWarehouseId, values.transitWarehouseId].filter(
            (v) => v != null && v !== ''
          )
          if (new Set(warehouses.map(String)).size !== warehouses.length) {
            throw new Error('调出、调入与在途仓库必须两两不同')
          }
          if (mode === 'create') {
            const saved = await stockTransferClient.create(values)
            const itemErrors = await persistItems(saved.id, items, [])
            if (itemErrors.length > 0) {
              toast.danger('调拨单已创建,但部分调拨行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('调拨单已创建')
            }
          } else {
            await stockTransferClient.update(rowId!, values)
            const itemErrors = await persistItems(rowId!, items, itemsSnapshot)
            if (itemErrors.length > 0) {
              toast.danger('调拨单已更新,但部分调拨行保存失败', { description: itemErrors.join('; ') })
            } else {
              toast.success('调拨单已更新')
            }
          }
          invalidateGrids()
        }}
      />

      <AlertDialog.Backdrop
        isOpen={receiveDoc !== null}
        onOpenChange={(open) => {
          if (!open && !receiving) setReceiveDoc(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[560px]" aria-label="调拨收货">
            <AlertDialog.Header>
              <AlertDialog.Heading>
                调拨收货{receiveDoc ? `(${String(receiveDoc.docNo ?? '')})` : ''}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-ink-500">
                逐行确认实收数量(0 ~ 已发数量);差额留在在途仓,后续用手工出入库单(出库)清理。
              </p>
              {receiveItems.isPending ? (
                <div className="flex h-24 items-center justify-center">
                  <Spinner />
                </div>
              ) : receiveItems.isError ? (
                <EmptyState size="sm" className="h-32 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>调拨行加载失败</EmptyState.Title>
                    <EmptyState.Description>{(receiveItems.error as Error).message}</EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button variant="secondary" onPress={() => receiveItems.refetch()}>
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {(receiveItems.data ?? []).map((r) => {
                    const shipped = Number(r.baseQty)
                    return (
                      <div key={r.id} className="flex items-end justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm">{String(r.materialName ?? '')}</p>
                          <p className="text-xs text-muted">
                            第{String(r.idx)}行 · 已发 {shipped} {String(r.unitName ?? '')}
                          </p>
                        </div>
                        <NumberField
                          className="w-32 shrink-0"
                          minValue={0}
                          maxValue={shipped}
                          value={receipts[r.id] ?? shipped}
                          onChange={(n) =>
                            setReceipts((prev) => ({ ...prev, [r.id]: Number.isFinite(n) ? n : 0 }))
                          }
                        >
                          <Label>实收数量</Label>
                          <NumberField.Group className="grid-cols-[1fr]">
                            <NumberField.Input />
                          </NumberField.Group>
                        </NumberField>
                      </div>
                    )
                  })}
                </div>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={receiving}>
                取消
              </Button>
              <Button
                variant="primary"
                isPending={receiving}
                isDisabled={!receiveItems.data || receiveItems.data.length === 0}
                onPress={submitReceive}
              >
                确认收货
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )
}
