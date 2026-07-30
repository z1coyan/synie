import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Label, Modal, TextField, toast } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { FieldInputProps, FieldOverride } from '~/components/synie-record-drawer/fields'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { RemoteDialogSelect } from '~/components/synie-remote-select/RemoteDialogSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import {
  applyWorkOrderBom,
  bomClient,
  bomComponentClient,
  createWorkOrderInlineBom,
  getWorkOrderBomSnapshot,
  workOrderClient,
} from '~/lib/resources/manufacturing'
import { fetchMyPermissions, hasPermission } from '~/lib/permissions'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/work-orders')({
  component: WorkOrdersPage,
})

const GRID_COLUMNS = [
  'workOrderNo',
  'materialCode',
  'materialName',
  'qty',
  'receivedBaseQty',
  'remainingBaseQty',
  'needDate',
  'status',
  'bomId',
  'demandId',
  'companyId',
]

const GRID_OVERRIDES = {
  materialCode: { mobileRole: 'hide' },
  companyId: { mobileRole: 'hide' },
  materialName: {
    mobileRole: 'title',
    render: (_v: unknown, row: Row) => {
      const code = row.materialCode != null ? String(row.materialCode) : ''
      const name = row.materialName != null ? String(row.materialName) : ''
      const text = [code, name].filter(Boolean).join(' ')
      return text || undefined
    },
  },
  workOrderNo: { mobileRole: 'subtitle' },
  status: { mobileRole: 'summary' },
  remainingBaseQty: { mobileRole: 'summary' },
  needDate: { mobileRole: 'summary' },
} satisfies Record<string, ColumnOverride>

type InlineComp = {
  key: string
  materialId: string | null
  unitId: string | null
  quantity: string
  lossRate: string
}

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
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const [inlineOpen, setInlineOpen] = useState(false)
  /** create 态新建 BOM 写回 form；edit 态走 createInlineBom */
  const [inlinePatch, setInlinePatch] = useState<
    ((patch: Record<string, unknown>) => void) | null
  >(null)
  const [inlineMaterialId, setInlineMaterialId] = useState<string | null>(null)
  const [inlinePlanName, setInlinePlanName] = useState('')
  const [inlineCode, setInlineCode] = useState('')
  const [inlineComps, setInlineComps] = useState<InlineComp[]>([
    { key: '1', materialId: null, unitId: null, quantity: '', lossRate: '' },
  ])
  const [inlineSaving, setInlineSaving] = useState(false)
  const queryClient = useQueryClient()

  const perms = useQuery({
    queryKey: ['myPermissions'],
    queryFn: fetchMyPermissions,
    staleTime: 60_000,
  })
  const canCreateBom = hasPermission(perms.data, 'mfg.bom:create')
  const canUpdateWo = hasPermission(perms.data, 'mfg.work_order:update')

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

  const openInlineCreate = (
    materialId: string | null,
    patchValues: ((patch: Record<string, unknown>) => void) | null,
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
    setInlineMaterialId(materialId)
    setInlinePatch(patchValues)
    setInlinePlanName('')
    setInlineCode('')
    setInlineComps([
      { key: '1', materialId: null, unitId: null, quantity: '', lossRate: '' },
    ])
    setInlineOpen(true)
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
        // create：写草稿；edit 进行中：即时 apply
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
                    // edit：即时应用快照
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
                        queryClient.invalidateQueries({
                          queryKey: ['gridRows', 'mfgWorkOrders'],
                        })
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
                  gridDefaultSort={{
                    column: 'code',
                    direction: 'ascending',
                  }}
                />
              </div>
              {(isCreate || canEditBomOnExisting) && (
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!materialId || !canCreateBom || disabled}
                  onPress={() =>
                    openInlineCreate(materialId, p.patchValues)
                  }
                >
                  新建 BOM
                </Button>
              )}
            </div>
            {!materialId && drawer?.mode === 'create' && (
              <p className="text-xs text-ink-500">
                选定来源需求行后，可引用本物料启用中 BOM 或现场新建。
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
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgWorkOrders'] })
    queryClient.invalidateQueries({ queryKey: ['rowById'] })
    if (rowId) {
      queryClient.invalidateQueries({
        queryKey: ['workOrderBomSnapshot', rowId],
      })
    }
  }

  const onCreateInline = async () => {
    if (!inlineMaterialId) return
    if (!canCreateBom) {
      toast.danger('无权限创建 BOM', {
        description: '需要 mfg.bom 写权限',
      })
      return
    }
    const components = inlineComps
      .filter((c) => c.materialId && c.unitId && c.quantity.trim())
      .map((c) => ({
        materialId: c.materialId!,
        unitId: c.unitId!,
        quantity: c.quantity.trim(),
        lossRate: c.lossRate.trim() ? c.lossRate.trim() : null,
      }))
    setInlineSaving(true)
    try {
      // create 态：先建启用 BOM 写回 form；edit 态：工单内嵌一键快照
      if (drawer?.mode === 'create' || !rowId) {
        const bom = (await bomClient.create({
          code: inlineCode.trim() || null,
          materialId: inlineMaterialId,
          planName: inlinePlanName.trim() || null,
          status: 'ACTIVE',
        })) as Row
        for (const c of components) {
          await bomComponentClient.create({
            bomId: bom.id,
            ...c,
          })
        }
        inlinePatch?.({ bomId: bom.id })
        toast.success(
          `BOM ${String(bom.code)} 已创建并选入（保存工单时快照）`,
        )
      } else {
        const result = (await createWorkOrderInlineBom(rowId, {
          code: inlineCode.trim() || null,
          planName: inlinePlanName.trim() || null,
          components,
        })) as { workOrder: Row; bom: Row }
        inlinePatch?.({ bomId: result.bom.id })
        setDrawer((d) =>
          d ? { ...d, row: { ...d.row, ...result.workOrder } } : d,
        )
        toast.success(`BOM ${String(result.bom.code)} 已创建并选入`)
        refreshWo()
      }
      setInlineOpen(false)
    } catch (e) {
      toast.danger('创建 BOM 失败', { description: (e as Error).message })
    } finally {
      setInlineSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产工单</h1>
      <p className="mt-2 text-sm text-ink-500">
        从已确认未关闭需求行生成；同一需求行可开多张工单，数量默认剩余可安排。新增时可选用启用中
        BOM 或现场新建；创建时复制物料图纸挂接（无图不拦）。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgWorkOrders"
          client={workOrderClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          attachmentImages={{
            ownerType: 'mfg_work_order',
            category: 'drawing',
            label: '图纸',
          }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgWorkOrders"
        client={workOrderClient}
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
            await workOrderClient.create({
              demandItemId: values.demandItemId,
              workOrderNo: values.workOrderNo || null,
              qty: values.qty || null,
              bomId: values.bomId || null,
            })
            toast.success('生产工单已生成')
          } else {
            await workOrderClient.update(drawer!.row!.id, {
              workOrderNo: values.workOrderNo,
            })
            toast.success('生产工单已更新')
          }
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'mfgWorkOrders'],
          })
        }}
      />

      <Modal.Backdrop
        isOpen={inlineOpen}
        onOpenChange={(open) => !open && setInlineOpen(false)}
      >
        <Modal.Container>
          <Modal.Dialog className="max-w-lg" aria-label="新建 BOM">
            <Modal.Header>
              <Modal.Heading>
                {drawer?.mode === 'create'
                  ? '新建 BOM 并选入工单'
                  : '新建 BOM 并快照到本工单'}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-3">
              <p className="text-sm text-ink-500">
                母物料锁定为当前工单物料；保存后进入 BOM 主数据（启用）
                {drawer?.mode === 'create'
                  ? '，并写入本表单；生成工单时一并快照。'
                  : '，并立即快照到本工单。'}
              </p>
              <TextField value={inlineCode} onChange={setInlineCode}>
                <Label>编号（可空自动取号）</Label>
                <Input placeholder="留空自动编号" />
              </TextField>
              <TextField value={inlinePlanName} onChange={setInlinePlanName}>
                <Label>方案名称</Label>
                <Input placeholder="如 自用" />
              </TextField>
              <div className="space-y-2">
                <p className="text-sm font-medium">配料行</p>
                {inlineComps.map((c, idx) => (
                  <div
                    key={c.key}
                    className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-2"
                  >
                    <RemoteSelect
                      resource="invMaterials"
                      value={c.materialId}
                      onChange={(v) =>
                        setInlineComps((rows) =>
                          rows.map((r, i) =>
                            i === idx
                              ? { ...r, materialId: v, unitId: null }
                              : r,
                          ),
                        )
                      }
                      labelField="name"
                      label="子物料"
                    />
                    <MaterialUnitSelect
                      materialId={c.materialId}
                      value={c.unitId}
                      onChange={(v) =>
                        setInlineComps((rows) =>
                          rows.map((r, i) =>
                            i === idx
                              ? {
                                  ...r,
                                  unitId:
                                    v == null || v === '' ? null : String(v),
                                }
                              : r,
                          ),
                        )
                      }
                      isDisabled={c.materialId == null}
                    />
                    <TextField
                      value={c.quantity}
                      onChange={(v) =>
                        setInlineComps((rows) =>
                          rows.map((r, i) =>
                            i === idx ? { ...r, quantity: v } : r,
                          ),
                        )
                      }
                    >
                      <Label>净用量</Label>
                      <Input placeholder="如 1" />
                    </TextField>
                    <TextField
                      value={c.lossRate}
                      onChange={(v) =>
                        setInlineComps((rows) =>
                          rows.map((r, i) =>
                            i === idx ? { ...r, lossRate: v } : r,
                          ),
                        )
                      }
                    >
                      <Label>损耗率（可空）</Label>
                      <Input placeholder="如 0.05" />
                    </TextField>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={() =>
                    setInlineComps((rows) => [
                      ...rows,
                      {
                        key: String(Date.now()),
                        materialId: null,
                        unitId: null,
                        quantity: '',
                        lossRate: '',
                      },
                    ])
                  }
                >
                  加一行配料
                </Button>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                isDisabled={inlineSaving}
                onPress={() => setInlineOpen(false)}
              >
                取消
              </Button>
              <Button
                isPending={inlineSaving}
                onPress={() => void onCreateInline()}
              >
                保存并选入
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
