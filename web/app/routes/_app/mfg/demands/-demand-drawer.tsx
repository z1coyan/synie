import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { useDocItems } from '~/components/synie-editable-table/use-doc-items'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import {
  confirmDemand,
  demandClient,
  demandItemClient,
} from '~/lib/resources/manufacturing'
import {
  auditMaterialCell,
  type AuditDocConfig,
} from '../../scm/-audit-doc'
import { SalesItemPicker } from './-sales-item-picker'
import {
  canChangeFulfillmentItem,
  canCompleteItem,
  canGenerateWorkOrder,
  useDemandItemActions,
  useMyPermissions,
} from './-item-actions'

const FULFILLMENT_LABELS: Record<string, string> = {
  MAKE: '自制',
  BUY: '外购',
  OUTSOURCE: '委外',
  STOCK: '库存',
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

// 需求行脚手架（取数/持久化）走共用 useDocItems。
const ITEMS = {
  label: '需求行',
  docIdField: 'demandId',
  client: demandItemClient,
  itemInput: (row: Row) => ({
    idx: row.idx,
    materialId: row.materialId,
    unitId: row.unitId,
    qty: row.qty,
    needDate: row.needDate ?? null,
    fulfillmentMethod: row.fulfillmentMethod,
    salesOrderItemId: row.salesOrderItemId || null,
    remarks: row.remarks ?? null,
  }),
  itemKeys: [
    'idx',
    'materialId',
    'unitId',
    'qty',
    'needDate',
    'fulfillmentMethod',
    'salesOrderItemId',
    'remarks',
  ] as const,
}

export const DEMAND_AUDIT_CONFIG = {
  docLabel: '履约需求单',
  itemsResource: 'mfgDemandItems',
  loadItems: (demandId) =>
    demandItemClient
      .query({
        limit: 200,
        offset: 0,
        filter: {
          demandId: {
            kind: 'fk',
            op: 'in',
            values: [demandId],
            labels: [],
          },
        },
        sort: { column: 'idx', direction: 'ascending' },
      })
      .then((result) => result.results),
  audit: confirmDemand,
  columns: [
    { key: 'materialName', label: '物料', render: auditMaterialCell() },
    { key: 'unitName', label: '单位' },
    { key: 'qty', label: '数量', align: 'end' },
    { key: 'needDate', label: '需求日' },
    {
      key: 'fulfillmentMethod',
      label: '履约方式',
      render: (value) =>
        value == null
          ? undefined
          : (FULFILLMENT_LABELS[String(value)] ?? String(value)),
    },
    { key: 'remarks', label: '行备注' },
  ],
} satisfies AuditDocConfig

export function DemandDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    demand: DemandRef | null
  } | null>(null)
  const { items, setItems, itemsLoaded, load, persistItems } =
    useDocItems(ITEMS)
  const queryClient = useQueryClient()
  const perms = useMyPermissions()

  // 行级操作后重拉抽屉里的需求行（行状态已变）。
  const itemActions = useDemandItemActions(() => {
    if (drawer?.demand) load(drawer.demand.id)
  })

  const canUpdateDemand = perms.data?.has('mfg.demand:update') ?? false
  const canCreateWorkOrder =
    perms.data?.has('mfg.work_order:create') ?? false

  const openDrawer: OpenDemandDrawer = (mode, demand) => {
    setDrawer({ mode, demand })
    load(mode === 'create' || !demand ? null : demand.id)
  }

  const draftOnly =
    !drawer?.demand || drawer.demand.status === 'DRAFT'
  const nextIdx =
    items.reduce((max, row) => Math.max(max, Number(row.idx) || 0), 0) + 1

  return (
    <DemandDrawerContext.Provider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="mfgDemands"
        client={demandClient}
        {...drawerConfig('mfgDemands')}
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
              client={demandItemClient}
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
                      return (
                        <>
                          {canUpdateDemand && canCompleteItem(item) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() =>
                                itemActions.requestComplete(item)
                              }
                            >
                              完成
                            </Button>
                          )}
                          {canUpdateDemand &&
                            canChangeFulfillmentItem(item) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() =>
                                  itemActions.requestChange(item)
                                }
                              >
                                改履约方式
                              </Button>
                            )}
                          {canCreateWorkOrder &&
                            canGenerateWorkOrder(item) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() =>
                                  itemActions.requestGenerate(item)
                                }
                              >
                                生成工单
                              </Button>
                            )}
                        </>
                      )
                    }
              }
              exclude={[
                'demandId',
                'companyId',
                'baseQty',
                'orderedQty',
                'receivedQty',
                'ordered',
                'remainingOrderableQty',
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
                'fulfillmentMethod',
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
                fulfillmentMethod: {
                  order: 5,
                  required: true,
                  defaultValue: 'MAKE',
                },
                salesOrderItemId: {
                  order: 6,
                  label: '来源销售条目',
                },
                remarks: { order: 7 },
              }}
            />
          )
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核命令。
          let savedId: string
          if (mode === 'create') {
            const created = await demandClient.create(values)
            savedId = String(created.id)
            const lineErrors = await persistItems(savedId)
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('需求单已创建')
          } else {
            savedId = drawer!.demand!.id
            await demandClient.update(savedId, values)
            if (draftOnly) {
              const lineErrors = await persistItems(savedId)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('需求单已更新')
          }
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgDemands'],
          })
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgDemandItems'],
          })
          queryClient.invalidateQueries({
            queryKey: ['rowById', 'mfgDemands'],
          })
          return savedId
        }}
      />
      {itemActions.dialogs}
    </DemandDrawerContext.Provider>
  )
}
