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
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceBindingFor } from '~/lib/resources/registry'
import { todayLocal } from '~/lib/form-defaults'
import {
  demandClient,
  demandItemClient,
} from '~/lib/resources/manufacturing'
import {
  auditMaterialCell,
  type AuditDocConfig,
} from '../../scm/-audit-doc'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useDocumentDrawer } from '~/lib/use-document-drawer'
import { SalesItemPicker } from './-sales-item-picker'
import { useResourceCapabilities } from '~/lib/use-resource-capabilities'
import { canGenerateWorkOrder, useDemandItemActions } from './-item-actions'

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

// 需求行脚手架:取数走骨架 loadDraft(下方 loadDemandItems);
// 持久化按 snapshot 比对做 删→增→改(见组件内 persistItems)。
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

/** 需求行整单取数:骨架 loadDraft 与行级操作后重拉共用(纯函数,不写 state/ref) */
const loadDemandItems = (demandId: string): Promise<Row[]> =>
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
    .then((d) => d.results ?? [])

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
  // 单据抽屉骨架:双态状态机、URL 身份→整单草稿装载(竞态安全)、深链补拉全部收口进 hook
  const drawer = useDocumentDrawer<Row[]>({
    resource: 'mfgDemands',
    urlSync,
    loadDraft: loadDemandItems,
  })
  const { isOpen, mode, rowId } = drawer
  // 编辑入口:urlSync 用 URL 自查行 status;本地态用 open 传入行的 status
  const demandStatus = drawer.row?.status
  const [items, setItems] = useState<Row[]>([])
  const [itemsSnapshot, setItemsSnapshot] = useState<Row[]>([])
  const queryClient = useQueryClient()
  const workOrderCaps = useResourceCapabilities('mfgWorkOrders')
  // 行级操作后重拉的竞态守卫:世代随开/关抽屉自增,过期回填丢弃(同骨架语义)
  const generationRef = useRef(0)
  generationRef.current = drawer.generation

  // 草稿 → 条目状态派生:draft 变化(含关闭/新建清空为 null)时初始化需求行及其保存比对基线
  useEffect(() => {
    const rows = drawer.draft ?? []
    setItems(rows)
    setItemsSnapshot(rows)
  }, [drawer.draft, drawer.generation]) // generation 覆盖 create/关闭的 null→null(draft 引用不变也需重置)

  // 提交:删除消失的存量行 → 新建本地行 → 更新变更行;返回逐行错误(空数组 = 全成功)
  const persistItems = async (demandId: string): Promise<string[]> => {
    const errors: string[] = []
    const currentIds = new Set(
      items.filter((r) => !isLocalRow(r)).map((r) => r.id),
    )

    for (const old of itemsSnapshot) {
      if (currentIds.has(old.id)) continue
      try {
        await ITEMS.client.delete(old.id)
      } catch (error) {
        errors.push(`${String(old.idx ?? '行')}:${(error as Error).message}`)
      }
    }

    for (const row of items) {
      if (isLocalRow(row)) {
        try {
          const input = { [ITEMS.docIdField]: demandId, ...ITEMS.itemInput(row) }
          await ITEMS.client.create(input)
        } catch (error) {
          errors.push(`${String(row.idx ?? '行')}:${(error as Error).message}`)
        }
        continue
      }
      const old = itemsSnapshot.find((s) => s.id === row.id)
      if (
        old &&
        ITEMS.itemKeys.some((k) => String(old[k] ?? '') !== String(row[k] ?? ''))
      ) {
        try {
          await ITEMS.client.update(row.id, ITEMS.itemInput(row))
        } catch (error) {
          errors.push(`${String(row.idx ?? '行')}:${(error as Error).message}`)
        }
      }
    }
    return errors
  }

  // 行级操作后重拉抽屉里的需求行（行状态已变）。
  const itemActions = useDemandItemActions(() => {
    if (!rowId) return
    const gen = drawer.generation
    loadDemandItems(rowId).then(
      (rows) => {
        if (generationRef.current !== gen) return
        setItems(rows)
        setItemsSnapshot(rows)
      },
      (e: unknown) => {
        if (generationRef.current !== gen) return
        toast.danger(`${ITEMS.label}加载失败`, {
          description: (e as Error).message,
        })
      },
    )
  })

  const canCreateWorkOrder = workOrderCaps.has('create')

  const openDrawer: OpenDemandDrawer = (nextMode, demand) => {
    drawer.open(nextMode, demand)
  }

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
          if (!open) drawer.close()
        }}
        rowId={rowId}
        onEdit={
          demandStatus === 'DRAFT' ? () => drawer.setMode('edit') : undefined
        }
        extraContent={(m, row, values) => {
          const editable =
            m !== 'view' &&
            (!row || row.status === 'DRAFT') &&
            (m === 'create' || drawer.detailLoaded)
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
