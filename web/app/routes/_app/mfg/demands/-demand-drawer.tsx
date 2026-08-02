import {
  createContext,
  useContext,
  useEffect,
  useRef,
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
import { resourceBindingFor } from '~/lib/resources/registry'
import { todayLocal } from '~/lib/form-defaults'
import { hasPermission } from '~/lib/permissions'
import {
  demandClient,
  demandItemClient,
} from '~/lib/resources/manufacturing'
import {
  auditMaterialCell,
  type AuditDocConfig,
} from '../../scm/-audit-doc'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SalesItemPicker } from './-sales-item-picker'
import {
  canGenerateWorkOrder,
  useDemandItemActions,
  useMyPermissions,
} from './-item-actions'

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
    salesOrderItemId: row.salesOrderItemId || null,
    remarks: row.remarks ?? null,
  }),
  itemKeys: [
    'idx',
    'materialId',
    'unitId',
    'qty',
    'needDate',
    'salesOrderItemId',
    'remarks',
  ] as const,
}

export const DEMAND_AUDIT_CONFIG = {
  docLabel: '履约需求单',
  resource: 'mfgDemands',
  commandKey: 'audit',
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

/**
 * 需求单创建/编辑抽屉(头+需求行)。
 * 需求单/需求行两 tab 共用;列表 layout 传 urlSync,开/关/模式走 URL。
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式写 ?record=&mode=,深链/刷新/后退可寻址。
 */
export function DemandDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // URL 源(列表 layout)与本地态二选一;明细始终本地
  const url = useRecordDrawerUrl('mfgDemands', { enabled: urlSync })
  const [localDrawer, setLocalDrawer] = useState<{
    mode: DrawerMode
    demand: DemandRef | null
  } | null>(null)
  const { items, setItems, itemsLoaded, load, persistItems } =
    useDocItems(ITEMS)
  const queryClient = useQueryClient()
  const perms = useMyPermissions()
  // 已为哪张需求单拉过明细;深链 effect 与 openDrawer 去重
  const loadedIdRef = useRef<string | null>(null)

  const isOpen = urlSync ? url.drawer !== null : localDrawer !== null
  const mode: DrawerMode = urlSync
    ? (url.drawer?.mode ?? 'view')
    : (localDrawer?.mode ?? 'view')
  const rowId: string | undefined = urlSync
    ? (url.drawer?.recordId ?? undefined)
    : localDrawer?.demand?.id != null
      ? String(localDrawer.demand.id)
      : undefined
  // 编辑入口:urlSync 用 hook 自查行 status;本地态用 open 传入的 demand.status
  const demandStatus = urlSync
    ? url.row?.status
    : localDrawer?.demand?.status

  const loadItems = (docId: string | null) => {
    loadedIdRef.current = docId
    load(docId)
  }

  // 行级操作后重拉抽屉里的需求行（行状态已变）。
  const itemActions = useDemandItemActions(() => {
    if (rowId) load(rowId)
  })

  const canCreateWorkOrder = hasPermission(
    perms.data,
    'mfg.work_order:create',
  )

  const openDrawer: OpenDemandDrawer = (nextMode, demand) => {
    if (urlSync) {
      url.open(nextMode, demand?.id != null ? String(demand.id) : null)
    } else {
      setLocalDrawer({ mode: nextMode, demand })
    }
    if (nextMode === 'create' || !demand) {
      loadItems(null)
      return
    }
    loadItems(String(demand.id))
  }

  // 深链/前进后退:URL 驱动打开时 openDrawer 未走,按 recordId 补拉明细
  useEffect(() => {
    if (!urlSync) return
    const d = url.drawer
    if (!d) {
      if (loadedIdRef.current != null) loadItems(null)
      return
    }
    if (d.mode === 'create' || d.recordId == null) {
      if (loadedIdRef.current != null) loadItems(null)
      return
    }
    if (loadedIdRef.current !== d.recordId) {
      loadItems(d.recordId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 URL 抽屉身份变化时响应
  }, [urlSync, url.drawer?.recordId, url.drawer?.mode])

  const draftOnly =
    mode === 'create' || !demandStatus || demandStatus === 'DRAFT'
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
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (open) return
          if (urlSync) url.close()
          else setLocalDrawer(null)
          loadedIdRef.current = null
        }}
        rowId={rowId}
        onEdit={
          demandStatus === 'DRAFT'
            ? () => {
                if (urlSync) url.setMode('edit')
                else
                  setLocalDrawer((current) =>
                    current ? { ...current, mode: 'edit' } : current,
                  )
              }
            : undefined
        }
        extraContent={(m, row, values) => {
          const editable =
            m !== 'view' &&
            (!row || row.status === 'DRAFT') &&
            (m === 'create' || itemsLoaded)
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
                  render: (v, r) =>
                    hasMaterialSnapshot(r)
                      ? demandItemMaterialCell(v, r)
                      : undefined,
                },
              }}
            />
          )
        }}
        onSubmit={async (values, submitMode) => {
          // 返回值供抽屉「保存并审核」取 id 调审核命令。
          let savedId: string
          if (submitMode === 'create') {
            const created = await demandClient.create(values)
            savedId = String(created.id)
            const lineErrors = await persistItems(savedId)
            if (lineErrors.length) throw new Error(lineErrors.join('; '))
            toast.success('需求单已创建')
          } else {
            savedId = String(rowId)
            await demandClient.update(savedId, values)
            if (draftOnly) {
              const lineErrors = await persistItems(savedId)
              if (lineErrors.length) throw new Error(lineErrors.join('; '))
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
