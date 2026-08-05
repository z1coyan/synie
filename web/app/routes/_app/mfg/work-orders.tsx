import { useMemo } from 'react'
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
  workOrderClient,
} from '~/lib/resources/manufacturing'
import { fetchMyPermissions, hasPermission } from '~/lib/permissions'
import type { Row } from '~/components/synie-data-grid/types'
import { useTemplatePrint } from '~/components/synie-print/TemplatePrintDialog'
import { WORK_ORDER_STATUS_ENUM_COLORS } from '~/lib/doc-status'
import { toastError } from '~/lib/toast'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { BomDrawerProvider, useBomDrawer } from './boms/-bom-drawer'
import { WorkOrderProgressCell } from './-work-order-progress-cell'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

const RESOURCE = 'mfgWorkOrders'

export const Route = createFileRoute('/_app/mfg/work-orders')({
  // extraFields:跳过默认首屏 loader
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
  'ownerDeptId',
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
    enumColors: WORK_ORDER_STATUS_ENUM_COLORS,
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
  // 归属部门:创建时按创建人部门盖章,车间按此列自建自见
  ownerDeptId: { label: '归属部门', mobileRole: 'hide' },
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
  // 内嵌 BOM 抽屉保持 urlSync 默认 false:不写宿主工单页 ?record=
  return (
    <BomDrawerProvider>
      <WorkOrdersPageInner />
    </BomDrawerProvider>
  )
}

function WorkOrdersPageInner() {
  // 工单主抽屉 URL 同步;内嵌 BOM 仍走本地 Provider
  const { drawer, open, setMode, close, row: drawerRow } =
    useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const openBomDrawer = useBomDrawer()
  const { start: startPrint, dialog: printDialog } =
    useTemplatePrint('mfg.work_order')

  const perms = useQuery({
    queryKey: ['myPermissions'],
    queryFn: fetchMyPermissions,
    staleTime: 60_000,
  })
  const canCreateBom = hasPermission(perms.data, 'mfg.bom:create')
  const canUpdateWo = hasPermission(perms.data, 'mfg.work_order:update')

  const rowId = drawer?.recordId ?? null
  // status 与 hook 自查行同缓存键(binding.cache.rowKey),不另发请求
  const woStatus =
    drawerRow?.status != null ? String(drawerRow.status) : ''
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

  const baseDrawer = drawerConfig(RESOURCE)

  const invalidateWorkOrderLists = () => {
    // 建单占安排，工单与来源需求投影都要刷新；缓存身份由各 binding 拥有。
    for (const resource of [RESOURCE, 'mfgDemandItems', 'mfgDemands']) {
      void resourceBindingFor(resource).cache.invalidateAll(queryClient)
    }
  }

  const refreshWoRow = (id: string) => {
    void resourceBindingFor(RESOURCE).cache.invalidateRow(queryClient, id)
    void queryClient.invalidateQueries({
      queryKey: ['workOrderBomSnapshot', id],
    })
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
      onCreated: (bom) => {
        const id = String(bom.id)
        if (drawer?.mode === 'create' || !rowId) {
          patchValues({ bomId: id })
          toast.success(
            `BOM ${String(bom.code ?? '')} 已选入表单，保存工单时快照`,
          )
          return
        }
        if (!canEditBomOnExisting) {
          patchValues({ bomId: id })
          return
        }
        void (async () => {
          try {
            await applyWorkOrderBom(rowId, id)
            patchValues({ bomId: id })
            toast.success(`BOM ${String(bom.code ?? '')} 已创建并选入工单`)
            invalidateWorkOrderLists()
            refreshWoRow(rowId)
          } catch (e) {
            toastError('BOM 已创建但选入工单失败')(e)
            patchValues({ bomId: id })
          }
        })()
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
                        toast.success(id ? '已选入 BOM 并快照' : '已清空 BOM')
                        invalidateWorkOrderLists()
                        refreshWoRow(rowId)
                      } catch (e) {
                        toastError('更新 BOM 失败')(e)
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
                  gridDefaultSort={{
                    column: 'code',
                    direction: 'ascending',
                  }}
                  // 行菜单「查看」→ 完整 BOM 只读抽屉(配料/路线/副产品);不写工单 URL
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
    if (rowId) refreshWoRow(rowId)
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
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          // 物料富单元格所需快照字段与物料外键(撤列后仍随查询取回;工单无 customerPartNo 快照)
          extraFields={['materialId', 'materialName', 'materialSpec']}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
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
        resource={RESOURCE}
        {...baseDrawer}
        fields={drawerFields}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        onEdit={() => setMode('edit')}
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
                            await applyWorkOrderBom(id, null)
                            toast.success('已清空 BOM 快照')
                            refreshWo()
                          } catch (e) {
                            toastError('清空失败')(e)
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
            await workOrderClient.create({
              demandItemId: values.demandItemId,
              workOrderNo: values.workOrderNo || null,
              qty: values.qty || null,
              bomId: values.bomId || null,
            })
            toast.success('生产工单已生成')
          } else {
            await workOrderClient.update(String(drawer!.recordId), {
              workOrderNo: values.workOrderNo,
            })
            toast.success('生产工单已更新')
          }
          invalidateWorkOrderLists()
        }}
      />
      {printDialog}
    </>
  )
}
