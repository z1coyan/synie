import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { FieldInputProps, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import {
  applyWorkOrderBom,
  getWorkOrderBomSnapshot,
} from '~/lib/resources/manufacturing'
import { hasPermission } from '~/lib/permissions'
import { useCurrentActor } from '~/lib/actor-context'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { useTemplatePrint } from '~/components/synie-print/TemplatePrintDialog'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { BomDrawerProvider, useBomDrawer } from './boms/-bom-drawer'
import { WorkOrderProgressCell } from './-work-order-progress-cell'
import { aggregateDraftFor, resourceBindingFor } from '~/lib/resources/registry'

const workOrderDraft = aggregateDraftFor('mfgWorkOrders')

export const Route = createFileRoute('/_app/mfg/work-orders')({
  component: WorkOrdersPage,
})

// 列白名单:companyId 作单据归属公司首列(桌面保留筛选,卡片藏);物料按全站约定合并为单个富单元格
// 列(materialCode 列承载,其余快照字段与物料外键经 extraFields 取回);
// qty/receivedBaseQty/remainingBaseQty 三个数量列合并为「入库进度」一列——列本体是 remainingBaseQty
// 计算列(筛选/排序即未完成数量口径),单元格进度条 + Popover 明细渲染,数量明细随 wire 全量返回无需 extraFields
const GRID_COLUMNS = [
  'companyId',
  'workOrderNo',
  'materialCode',
  'remainingBaseQty',
  'needDate',
  'status',
  'bomId',
  'demandId',
]

const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  // 物料列:全站统一富单元格(图纸缩略图+快照编号/名称/规格,编号点开物料速览);
  // 创建工单时已复制物料图纸挂接到工单,缩略图优先用工单快照图纸
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender({ drawingOwnerType: 'mfg_work_order' }),
  },
  workOrderNo: { mobileRole: 'subtitle' },
  // 状态胶囊配色:进行中蓝、已完工绿、已作废红(与需求单页同套约定)
  status: {
    mobileRole: 'summary',
    enumColors: { IN_PROGRESS: 'accent', COMPLETED: 'success', VOIDED: 'danger' },
  },
  // 合并列:进度条 + Popover 展示 已入/数量·未完成(折回行单位,见 WorkOrderProgressCell);
  // 列筛选/排序 = 未完成数量
  remainingBaseQty: {
    label: '入库进度',
    mobileRole: 'summary',
    align: 'start',
    render: (_v: unknown, row: Row) => <WorkOrderProgressCell row={row} />,
  },
  needDate: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

function bomGridFilter(materialId: string) {
  return {
    materialId: {
      kind: 'fk' as const,
      op: 'in' as const,
      values: [materialId],
      labels: [],
    },
    status: {
      kind: 'enum' as const,
      op: 'in' as const,
      values: ['ACTIVE'],
    },
  }
}

function WorkOrdersPage() {
  return (
    <BomDrawerProvider>
      <WorkOrdersPageInner />
    </BomDrawerProvider>
  )
}

function WorkOrdersPageInner() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const queryClient = useQueryClient()
  const openBomDrawer = useBomDrawer()
  const { start: startPrint, dialog: printDialog } =
    useTemplatePrint('mfg.work_order')

  const actor = useCurrentActor()
  const permissions = useMemo(() => {
    const current = new Set(actor.permissions)
    if (actor.superAdmin) current.add('*')
    return current as ReadonlySet<string>
  }, [actor.permissions, actor.superAdmin])
  const canCreateBom = hasPermission(permissions, 'mfg.bom:create')
  const canUpdateWo = hasPermission(permissions, 'mfg.work_order:update')

  const rowId = drawer?.row?.id ? String(drawer.row.id) : null
  const woStatus = drawer?.row?.status != null ? String(drawer.row.status) : ''
  const canEditBomOnExisting =
    canUpdateWo &&
    drawer?.mode !== 'create' &&
    rowId != null &&
    woStatus === 'IN_PROGRESS'

  const snapshot = useQuery({
    queryKey: ['workOrderBomSnapshot', rowId],
    queryFn: () => getWorkOrderBomSnapshot(rowId!),
    enabled: rowId != null && drawer?.mode !== 'create',
  })

  const baseDrawer = drawerConfig('mfgWorkOrders')

  const invalidateWorkOrderLists = () => {
    // 建单占安排，工单与来源需求投影都要刷新；缓存身份由各 binding 拥有。
    for (const resource of ['mfgWorkOrders', 'mfgDemandItems', 'mfgDemands']) {
      void resourceBindingFor(resource).cache.invalidateAll(queryClient)
    }
  }

  /** 打开完整 BOM 创建 drawer；成功后回填 bomId / 已有工单则 apply */
  const openCreateBom = (
    materialId: string | null,
    patchValues: (patch: Record<string, unknown>) => void,
  ) => {
    if (!materialId) {
      toast.danger('请先选择来源需求行')
      return
    }
    if (!canCreateBom) {
      toast.danger('无权限创建 BOM', {
        description: '需要 mfg.bom 写权限；可选用已有启用中 BOM',
      })
      return
    }
    openBomDrawer('create', null, {
      materialId,
      lockMaterial: true,
      createStatus: 'ACTIVE',
      ...(canEditBomOnExisting && rowId ? { workOrderId: rowId } : {}),
      onCreated: (bom) => {
        const id = String(bom.id)
        patchValues({ bomId: id })
        toast.success(
          `BOM ${String(bom.code ?? '')} 已选入表单，保存工单时快照`,
        )
      },
      onInlineCreated: ({ workOrder, bom }) => {
        const id = String(bom.id)
        patchValues({ bomId: id })
        setDrawer((d) => d ? { ...d, row: { ...d.row, ...workOrder } } : d)
        toast.success(`BOM ${String(bom.code ?? '')} 已创建并选入工单`)
        invalidateWorkOrderLists()
        queryClient.invalidateQueries({ queryKey: ['workOrderBomSnapshot', rowId] })
      },
    })
  }

  const bomFieldOverride = useMemo((): FieldOverride => {
    return {
      ...(baseDrawer.fields?.bomId ?? {}),
      input: (p: FieldInputProps) => {
        const materialId =
          p.values.materialId == null || p.values.materialId === ''
            ? null
            : String(p.values.materialId)
        const value =
          p.value == null || p.value === '' ? null : String(p.value)
        const isCreate = drawer?.mode === 'create'
        const disabled =
          p.isDisabled ||
          !materialId ||
          (drawer?.mode === 'edit' && !canEditBomOnExisting) ||
          drawer?.mode === 'view'

        return (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <RemoteDialogSelect
                  resource="mfgBoms"
                  value={value}
                  onChange={(id) => {
                    if (isCreate || drawer?.mode === 'view') {
                      p.onChange(id)
                      return
                    }
                    if (!rowId || !canEditBomOnExisting) {
                      p.onChange(id)
                      return
                    }
                    void (async () => {
                      try {
                        const updated = (await applyWorkOrderBom(
                          rowId,
                          id,
                        )) as Row
                        p.onChange(
                          updated.bomId == null || updated.bomId === ''
                            ? null
                            : String(updated.bomId),
                        )
                        setDrawer((d) =>
                          d ? { ...d, row: { ...d.row, ...updated } } : d,
                        )
                        toast.success(id ? '已选入 BOM 并快照' : '已清空 BOM')
                        invalidateWorkOrderLists()
                        queryClient.invalidateQueries({
                          queryKey: ['workOrderBomSnapshot', rowId],
                        })
                      } catch (e) {
                        toast.danger('更新 BOM 失败', {
                          description: (e as Error).message,
                        })
                      }
                    })()
                  }}
                  labelField="code"
                  label="BOM"
                  placeholder={
                    materialId
                      ? '点击选择启用中 BOM…'
                      : '先选来源需求行'
                  }
                  dialogTitle="选择 BOM"
                  dialogClassName="max-w-4xl"
                  isDisabled={disabled}
                  gridFilter={
                    materialId ? bomGridFilter(materialId) : undefined
                  }
                  gridColumns={['code', 'planName', 'status', 'note']}
                  // 行菜单「查看」→ 完整 BOM 只读抽屉(配料/路线/副产品)
                  onView={(row) => openBomDrawer('view', row)}
                />
              </div>
              {(isCreate || canEditBomOnExisting) && (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!materialId || !canCreateBom || disabled}
                  onPress={() => openCreateBom(materialId, p.patchValues)}
                >
                  新建 BOM
                </Button>
              )}
            </div>
            {!materialId && drawer?.mode === 'create' && (
              <p className="text-xs text-ink-500">
                选定来源需求行后，可引用本物料启用中 BOM，或打开完整 BOM
                表单新建。
              </p>
            )}
            {materialId && !canCreateBom && (
              <p className="text-xs text-ink-500">
                无 BOM 创建权限时仅能选用已有启用中配方。
              </p>
            )}
          </div>
        )
      },
    }
  }, [
    baseDrawer.fields?.bomId,
    canCreateBom,
    canEditBomOnExisting,
    drawer?.mode,
    queryClient,
    rowId,
  ])

  const drawerFields = useMemo(
    () => ({
      ...baseDrawer.fields,
      bomId: bomFieldOverride,
    }),
    [baseDrawer.fields, bomFieldOverride],
  )

  const refreshWo = () => {
    invalidateWorkOrderLists()
    if (rowId) {
      queryClient.invalidateQueries({
        queryKey: ['workOrderBomSnapshot', rowId],
      })
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产工单</h1>
      <p className="mt-2 text-sm text-ink-500">
        从已确认未关闭需求行生成；同一需求行可开多张工单，数量默认剩余可安排。新增时可
        dialog 选用启用中 BOM，或打开完整 BOM 表单新建；创建时复制物料图纸挂接。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgWorkOrders"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          // 物料富单元格所需快照字段与物料外键(撤列后仍随查询取回;工单无 customerPartNo 快照)
          extraFields={['materialId', 'materialName', 'materialSpec']}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          // 模板打印覆盖默认列表 HTML 打印（无模板时弹窗提示去上传）
          onPrint={(rows) => void startPrint('print', rows)}
          rowActions={[
            {
              key: 'exportExcel',
              label: '导出 Excel',
              capability: 'export',
              onAction: (row) => void startPrint('export', [row]),
            },
          ]}
          bulkActions={[
            {
              key: 'batchExportExcel',
              label: '批量导出 Excel',
              capability: 'export',
              onAction: (rows) => void startPrint('export', rows),
            },
          ]}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgWorkOrders"
        {...baseDrawer}
        fields={drawerFields}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        extraContent={(mode, row) => {
          if (mode === 'create' || !row) return null
          const id = String(row.id)
          const snap = snapshot.data as
            | {
                components?: Array<{
                  materialId: string
                  quantity: string
                  lossRate: string | null
                }>
                routes?: Array<{ operationId: string; seq: number }>
              }
            | undefined

          return (
            <div className="mt-4 space-y-4 border-t border-border pt-4">
              <div>
                <p className="mb-2 text-sm font-medium">图纸</p>
                <SynieAttachmentPanel
                  ownerType="mfg_work_order"
                  ownerId={id}
                  category="drawing"
                  label="图纸"
                  readonly
                />
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">BOM 快照</p>
                {canEditBomOnExisting && (
                  <div className="mb-2">
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={!row.bomId}
                      onPress={() => {
                        void (async () => {
                          try {
                            const updated = (await applyWorkOrderBom(
                              id,
                              null,
                            )) as Row
                            setDrawer((d) =>
                              d
                                ? { ...d, row: { ...d.row, ...updated } }
                                : d,
                            )
                            toast.success('已清空 BOM 快照')
                            refreshWo()
                          } catch (e) {
                            toast.danger('清空失败', {
                              description: (e as Error).message,
                            })
                          }
                        })()
                      }}
                    >
                      清空 BOM
                    </Button>
                  </div>
                )}
                {snapshot.isLoading ? (
                  <p className="text-sm text-ink-500">加载快照…</p>
                ) : snap?.components && snap.components.length > 0 ? (
                  <ul className="space-y-1 text-sm">
                    {snap.components.map((c, i) => (
                      <li key={i} className="text-ink-600">
                        配料 {c.materialId.slice(0, 8)}… × {c.quantity}
                        {c.lossRate != null ? `（损耗 ${c.lossRate}）` : ''}
                      </li>
                    ))}
                    {(snap.routes ?? []).map((r, i) => (
                      <li key={`r${i}`} className="text-ink-500">
                        工序 seq {r.seq}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-500">暂无快照配料</p>
                )}
              </div>
            </div>
          )
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const created = await workOrderDraft.createDraft({
              demandItemId: values.demandItemId,
              workOrderNo: values.workOrderNo || null,
              qty: values.qty || null,
              bomId: values.bomId || null,
            }) as Row
            toast.success('生产工单已生成')
            invalidateWorkOrderLists()
            return created.id
          } else {
            const id = drawer!.row!.id
            const current = await workOrderDraft.loadDraft(id) as Row
            await workOrderDraft.replaceDraft(id, {
              ...current,
              workOrderNo: values.workOrderNo,
            })
            toast.success('生产工单已更新')
            invalidateWorkOrderLists()
            return id
          }
        }}
      />
      {printDialog}
    </>
  )
}
