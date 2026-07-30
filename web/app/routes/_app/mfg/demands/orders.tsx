import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { useDocItems } from '~/components/synie-editable-table/use-doc-items'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { demandClient, demandItemClient } from '~/lib/resources/manufacturing'
import { SalesItemPicker } from './-sales-item-picker'
import {
  canChangeFulfillmentItem,
  canCompleteItem,
  canGenerateWorkOrder,
  useDemandItemActions,
  useMyPermissions,
} from './-item-actions'

export const Route = createFileRoute('/_app/mfg/demands/orders')({
  component: DemandOrdersTab,
})

// 需求行脚手架(取数/持久化)走共用 useDocItems;变量名统一 $docId
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

const GRID_COLUMNS = [
  'demandNo',
  'demandDate',
  'companyId',
  'status',
  'remarks',
]

// 状态机动作显隐(后端权威校验兜底,这里做体验层):确认/删除/编辑仅草稿;
// 关闭/作废仅已确认(后端已收紧:草稿不可作废,走删除)
const ACTION_VISIBLE = {
  edit: (row: Row) => row.status === 'DRAFT',
  confirm: (row: Row) => row.status === 'DRAFT',
  close: (row: Row) => row.status === 'CONFIRMED',
  void: (row: Row) => row.status === 'CONFIRMED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// 状态胶囊配色:草稿灰、已确认绿、已关闭黄、已作废红
// 卡片:需求单号标题、日期副标题、状态/公司摘要
const GRID_OVERRIDES = {
  demandNo: { mobileRole: 'title' },
  demandDate: { mobileRole: 'subtitle' },
  status: {
    mobileRole: 'summary',
    enumColors: {
      DRAFT: 'default',
      CONFIRMED: 'success',
      CLOSED: 'warning',
      VOIDED: 'danger',
    },
  },
  companyId: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

function DemandOrdersTab() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const { items, setItems, itemsLoaded, load, persistItems } =
    useDocItems(ITEMS)
  const queryClient = useQueryClient()
  const perms = useMyPermissions()
  // 行级操作后重拉抽屉里的需求行(行状态已变)
  const itemActions = useDemandItemActions(() => {
    if (drawer?.row) load(String(drawer.row.id))
  })

  const canUpdateDemand = perms.data?.has('mfg.demand:update') ?? false
  const canCreateWorkOrder = perms.data?.has('mfg.work_order:create') ?? false

  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    setDrawer({ mode, row })
    load(mode === 'create' || !row ? null : String(row.id))
  }

  const draftOnly = !drawer?.row || drawer.row.status === 'DRAFT'
  const nextIdx = items.reduce((m, r) => Math.max(m, Number(r.idx) || 0), 0) + 1

  return (
    <>
      <SynieDataGrid
        resource="mfgDemands"
        client={demandClient}
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) =>
          openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)
        }
        actionVisible={ACTION_VISIBLE}
      />

      <SynieRecordDrawer
        resource="mfgDemands"
        client={demandClient}
        {...drawerConfig('mfgDemands')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        tabExtraContent={{
          items: (mode, row, values) => {
            const editable =
              mode !== 'view' &&
              (!row || row.status === 'DRAFT') &&
              (mode === 'create' || itemsLoaded)
            // create 态公司取自表单草稿,edit/view 态取自行数据
            const companyId = (row?.companyId ?? values.companyId) as
              string | null | undefined
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
                        .map((r) => String(r.salesOrderItemId ?? ''))
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
                  // 行级操作只针对已确认单上的行;草稿单走编辑/删除,不渲染操作列
                  !row || row.status === 'DRAFT'
                    ? undefined
                    : (r) => {
                        if (isLocalRow(r)) return null
                        return (
                          <>
                            {canUpdateDemand && canCompleteItem(r) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => itemActions.requestComplete(r)}
                              >
                                完成
                              </Button>
                            )}
                            {canUpdateDemand && canChangeFulfillmentItem(r) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => itemActions.requestChange(r)}
                              >
                                改履约方式
                              </Button>
                            )}
                            {canCreateWorkOrder && canGenerateWorkOrder(r) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => itemActions.requestGenerate(r)}
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
                  materialId: { order: 1, required: true, picker: 'dialog' },
                  unitId: { order: 2, required: true },
                  qty: { order: 3, required: true },
                  needDate: { order: 4 },
                  fulfillmentMethod: {
                    order: 5,
                    required: true,
                    defaultValue: 'MAKE',
                  },
                  salesOrderItemId: { order: 6, label: '来源销售条目' },
                  remarks: { order: 7 },
                }}
              />
            )
          },
        }}
        onSubmit={async (values, mode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核 mutation(通用约定)
          let savedId: string
          if (mode === 'create') {
            const created = await demandClient.create(values)
            const id = created.id
            const lineErrors = await persistItems(id)
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('需求单已创建')
            savedId = id
          } else {
            await demandClient.update(drawer!.row!.id, values)
            if (draftOnly) {
              const lineErrors = await persistItems(drawer!.row!.id as string)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
            }
            toast.success('需求单已更新')
            savedId = drawer!.row!.id as string
          }
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgDemands'],
          })
          queryClient.invalidateQueries({ queryKey: ['rowById', 'mfgDemands'] })
          return savedId
        }}
      />
      {itemActions.dialogs}
    </>
  )
}
