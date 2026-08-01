import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { aggregateDraftFor, resourceBindingFor } from '~/lib/resources/registry'
import { readResourceRowsBounded } from '~/lib/resources/bounded-reader'
import { hasPermission } from '~/lib/permissions'
import {
  auditMaterialCell,
  type AuditDocConfig,
} from '../../scm/-audit-doc'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { SalesItemPicker } from './-sales-item-picker'
import {
  canGenerateWorkOrder,
  useDemandItemActions,
  useMyPermissions,
} from './-item-actions'

// 本地日期 YYYY-MM-DD（不用 toISOString：UTC 串在 UTC+8 凌晨会差一天）。
function todayLocal(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 需求单共享抽屉：需求单与需求行两个列表共用同一份整单录入界面。
 * 基本信息和需求行同屏展示；后端确认动作以 audit 命令别名接入通用「保存并审核」。
 */

export interface DemandRef {
  id: string
  status?: unknown
}

export type OpenDemandDrawer = (
  mode: DrawerMode,
  demand: DemandRef | null,
) => void

const DemandDrawerContext = createContext<OpenDemandDrawer>(() => {})

export function useDemandDrawer(): OpenDemandDrawer {
  return useContext(DemandDrawerContext)
}

const demandDraft = aggregateDraftFor('mfgDemands')

function itemInput(row: Row) {
  return {
    ...(isLocalRow(row) ? {} : { id: row.id }),
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    needDate: row.needDate ?? null,
    salesOrderItemId: row.salesOrderItemId || null,
    remarks: row.remarks ?? null,
  }
}

export const DEMAND_AUDIT_CONFIG = {
  docLabel: '履约需求单',
  resource: 'mfgDemands',
  commandKey: 'audit',
  itemsResource: 'mfgDemandItems',
  loadItems: (demandId) =>
    readResourceRowsBounded(
      resourceBindingFor('mfgDemandItems').reader,
      {
        profile: 'default',
        fixedFilter: { demandId },
        sort: { column: 'idx', direction: 'ascending' },
      },
      200,
    ),
  columns: [
    { key: 'materialName', label: '物料', render: auditMaterialCell() },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '数量', align: 'end' },
    { key: 'needDate', label: '需求日' },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

// 条目表格物料列:全站统一富单元格(需求行无图纸挂接,缩略图回退物料当前图纸);
// 本地新行无平铺快照(销售条目选择器只带 join 对象)返回 undefined 回落默认 fk 渲染
const demandItemMaterialCell = materialCellRender()
const hasMaterialSnapshot = (row: Row) =>
  (row.materialCode != null && row.materialCode !== '') ||
  (row.materialName != null && row.materialName !== '')

export function DemandDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    demand: DemandRef | null
  } | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [itemsLoaded, setItemsLoaded] = useState(false)
  const requestRef = useRef(0)
  const queryClient = useQueryClient()
  const perms = useMyPermissions()

  // 行级操作后重拉抽屉里的需求行（行状态已变）。
  const itemActions = useDemandItemActions(() => {
    if (drawer?.demand) void loadItems(drawer.demand.id)
  })

  const canCreateWorkOrder = hasPermission(
    perms.data,
    'mfg.work_order:create',
  )

  const loadItems = async (id: string) => {
    const request = ++requestRef.current
    setItemsLoaded(false)
    try {
      const draft = await demandDraft.loadDraft(id) as Row
      if (request !== requestRef.current) return
      setItems((draft.items as Row[] | undefined) ?? [])
      setItemsLoaded(true)
    } catch (error) {
      if (request !== requestRef.current) return
      setItems([])
      toast.danger('需求行加载失败', { description: (error as Error).message })
    }
  }

  const openDrawer: OpenDemandDrawer = (mode, demand) => {
    setDrawer({ mode, demand })
    if (mode === 'create' || !demand) {
      ++requestRef.current
      setItems([])
      setItemsLoaded(true)
    } else {
      void loadItems(demand.id)
    }
  }

  const draftOnly =
    !drawer?.demand || drawer.demand.status === 'DRAFT'
  const nextIdx =
    items.reduce((max, row) => Math.max(max, Number(row.idx) || 0), 0) + 1
  const baseDrawerConfig = drawerConfig('mfgDemands')
  const demandDrawerConfig = {
    ...baseDrawerConfig,
    fields: {
      ...baseDrawerConfig.fields,
      demandDate: {
        ...baseDrawerConfig.fields?.demandDate,
        defaultValue: todayLocal(),
      },
    },
  }

  return (
    <DemandDrawerContext.Provider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="mfgDemands"
        {...demandDrawerConfig}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.demand?.id}
        onEdit={
          drawer?.demand?.status === 'DRAFT'
            ? () =>
                setDrawer((current) =>
                  current ? { ...current, mode: 'edit' } : current,
                )
            : undefined
        }
        extraContent={(mode, row, values) => {
          const editable =
            mode !== 'view' &&
            (!row || row.status === 'DRAFT') &&
            (mode === 'create' || itemsLoaded)
          // create 态公司取自表单草稿，edit/view 态取自行数据。
          const companyId = (row?.companyId ?? values.companyId) as
            | string
            | null
            | undefined

          return (
            <SynieEditableTable
              resource="mfgDemandItems"
              label="需求行"
              items={items}
              onChange={setItems}
              readOnly={!editable}
              toolbar={
                editable ? (
                  <SalesItemPicker
                    companyId={companyId ? String(companyId) : null}
                    excludeItemIds={items
                      .map((item) => String(item.salesOrderItemId ?? ''))
                      .filter(Boolean)}
                    nextIdx={nextIdx}
                    onConfirm={(rows) => {
                      setItems([...items, ...rows])
                      toast.success(`已纳入 ${rows.length} 行销售需求`)
                    }}
                  />
                ) : undefined
              }
              rowActions={
                // 行级操作只针对已确认单上的行；草稿单走编辑/删除。
                !row || row.status === 'DRAFT'
                  ? undefined
                  : (item) => {
                      if (isLocalRow(item)) return null
                      if (
                        !canCreateWorkOrder ||
                        !canGenerateWorkOrder(item)
                      ) {
                        return null
                      }
                      return (
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => itemActions.requestGenerate(item)}
                        >
                          生成工单
                        </Button>
                      )
                    }
              }
              exclude={[
                'demandId',
                'companyId',
                'baseQty',
                'orderedQty',
                'receivedQty',
                'arrangedQty',
                'completedQty',
                'ordered',
                'remainingOrderableQty',
                'remainingArrangeableQty',
                'fulfillmentMethod',
                'status',
                'materialCode',
                'materialName',
                'materialSpec',
                'unitName',
              ]}
              columns={[
                'idx',
                'materialId',
                'unitId',
                'qty',
                'needDate',
                'salesOrderItemId',
                'remarks',
              ]}
              fields={{
                idx: { order: 0, required: true },
                materialId: {
                  order: 1,
                  required: true,
                  picker: 'dialog',
                },
                unitId: { order: 2, required: true },
                qty: { order: 3, required: true },
                needDate: { order: 4 },
                salesOrderItemId: {
                  order: 5,
                  label: '来源销售条目',
                },
                remarks: { order: 6 },
              }}
              overrides={{
                materialId: {
                  label: '物料',
                  render: (v, row) =>
                    hasMaterialSnapshot(row)
                      ? demandItemMaterialCell(v, row)
                      : undefined,
                },
              }}
            />
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核命令。
          let savedId: string
          const input = { ...values, items: items.map(itemInput) }
          if (mode === 'create') {
            const created = await demandDraft.createDraft(input) as Row
            savedId = String(created.id)
            toast.success('需求单已创建')
          } else {
            savedId = drawer!.demand!.id
            if (draftOnly) {
              await demandDraft.replaceDraft(savedId, input)
            }
            toast.success('需求单已更新')
          }
          await Promise.all([
            resourceBindingFor('mfgDemands').cache.invalidateAll(queryClient),
            resourceBindingFor('mfgDemandItems').cache.invalidateGrid(queryClient),
          ])
          return savedId
        }}
      />
      {itemActions.dialogs}
    </DemandDrawerContext.Provider>
  )
}
