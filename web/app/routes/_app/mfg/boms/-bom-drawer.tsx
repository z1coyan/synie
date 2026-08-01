import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Modal, toast } from '@heroui/react'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import {
  applyRouteTemplate as applyBomRouteTemplate,
  createWorkOrderInlineBom,
  type WorkOrderInlineBomInput,
} from '~/lib/resources/manufacturing'
import type { Row } from '~/components/synie-data-grid/types'
import { aggregateDraftFor, resourceBindingFor } from '~/lib/resources/registry'

const bomDraft = aggregateDraftFor('mfgBoms')

// mutation input 只收行自身字段,行上挂的 material/unit/operation join 对象不进 payload
function componentInput(row: Row): NonNullable<WorkOrderInlineBomInput['components']>[number] {
  return {
    materialId: String(row.materialId),
    unitId: String(row.unitId),
    quantity: String(row.quantity),
    lossRate: row.lossRate == null ? null : String(row.lossRate),
    note: row.note == null ? null : String(row.note),
  }
}

function routeInput(row: Row): NonNullable<WorkOrderInlineBomInput['routes']>[number] {
  return {
    operationId: String(row.operationId),
    seq: Number(row.seq),
    requirement: row.requirement == null ? null : String(row.requirement),
    isOutsourced: Boolean(row.isOutsourced),
  }
}

function byproductInput(row: Row): NonNullable<WorkOrderInlineBomInput['byproducts']>[number] {
  return {
    materialId: String(row.materialId),
    unitId: String(row.unitId),
    quantity: String(row.quantity),
    note: row.note == null ? null : String(row.note),
  }
}

function aggregateRows<T extends Record<string, unknown>>(
  rows: Row[],
  input: (row: Row) => T,
): Array<T & { id?: string }> {
  return rows.map((row) => ({
    ...(isLocalRow(row) ? {} : { id: row.id }),
    ...input(row),
  }))
}

export interface OpenBomDrawerOptions {
  /** create 态预填/锁定母物料（工单内嵌创建用） */
  materialId?: string | null
  /** 锁定母物料不可改 */
  lockMaterial?: boolean
  /**
   * create 时 BOM 状态。工单引用需 ACTIVE；主数据页默认草稿。
   */
  createStatus?: 'DRAFT' | 'ACTIVE'
  /** 已持久化工单内嵌创建时，在同一事务内创建、启用并选入 BOM。 */
  workOrderId?: string
  /** create 成功后回调，供尚未持久化的工单表单回填 bomId */
  onCreated?: (bom: Row) => void
  /** 工单内嵌创建完成后的权威聚合快照。 */
  onInlineCreated?: (result: { workOrder: Row; bom: Row }) => void
}

export type OpenBomDrawer = (
  mode: DrawerMode,
  row: Row | null,
  options?: OpenBomDrawerOptions,
) => void

const BomDrawerContext = createContext<OpenBomDrawer>(() => {})

export function useBomDrawer(): OpenBomDrawer {
  return useContext(BomDrawerContext)
}

/**
 * 完整 BOM 创建/编辑抽屉（配料/路线/副产品 + 模板带入）。
 * BOM 列表页与生产工单「新建 BOM」共用，避免工单侧再实现一套表单。
 */
export function BomDrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
    options?: OpenBomDrawerOptions
  } | null>(null)
  const [components, setComponents] = useState<Row[]>([])
  const [routes, setRoutes] = useState<Row[]>([])
  const [byproducts, setByproducts] = useState<Row[]>([])
  const [linesLoaded, setLinesLoaded] = useState(false)
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const queryClient = useQueryClient()
  const reqIdRef = useRef(0)

  const openDrawer: OpenBomDrawer = (mode, row, options) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row, options })
    if (mode === 'create' || !row) {
      setComponents([])
      setRoutes([])
      setByproducts([])
      setLinesLoaded(true)
      return
    }
    setLinesLoaded(false)
    bomDraft.loadDraft(row.id)
      .then((draft) => {
        if (my !== reqIdRef.current) return
        const aggregate = draft as Row
        setComponents((aggregate.components as Row[] | undefined) ?? [])
        setRoutes((aggregate.routes as Row[] | undefined) ?? [])
        setByproducts((aggregate.byproducts as Row[] | undefined) ?? [])
        setLinesLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('BOM 明细加载失败', { description: (e as Error).message })
        setComponents([])
        setRoutes([])
        setByproducts([])
      })
  }

  async function applyRouteTemplate() {
    const bomId = drawer?.row?.id
    if (!bomId || templateId == null) return
    setApplying(true)
    try {
      const result = await applyBomRouteTemplate(bomId, templateId)
      const nextRoutes = Array.isArray(result)
        ? result as Row[]
        : ((await bomDraft.loadDraft(bomId) as Row).routes as Row[] | undefined) ?? []
      setRoutes(nextRoutes)
      toast.success('已从模板带入工艺路线')
      setTemplatePickerOpen(false)
      setTemplateId(null)
    } catch (e) {
      toast.danger('从模板带入失败', { description: (e as Error).message })
    } finally {
      setApplying(false)
    }
  }

  const opts = drawer?.options
  const lockedMaterialId =
    opts?.lockMaterial && opts.materialId
      ? String(opts.materialId)
      : null
  const prefillMaterialId =
    lockedMaterialId ??
    (opts?.materialId ? String(opts.materialId) : null)

  const baseConfig = drawerConfig('mfgBoms')
  const fields = {
    ...baseConfig.fields,
    materialId: {
      ...baseConfig.fields?.materialId,
      ...(prefillMaterialId
        ? { defaultValue: prefillMaterialId }
        : {}),
      ...(lockedMaterialId
        ? {
            edit: 'readOnly' as const,
            placeholder: '锁定为工单物料',
          }
        : {}),
    },
  }

  return (
    <BomDrawerContext.Provider value={openDrawer}>
      {children}

      <SynieRecordDrawer
        resource="mfgBoms"
        {...baseConfig}
        fields={fields}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        tabExtraContent={{
          components: (mode) => (
            <SynieEditableTable
              resource="mfgBomComponents"
              label="配料"
              items={components}
              onChange={setComponents}
              readOnly={mode === 'view' || (mode !== 'create' && !linesLoaded)}
              exclude={['bomId']}
              columns={['materialId', 'unitId', 'quantity', 'lossRate', 'note']}
              fields={{
                materialId: {
                  order: 0,
                  required: true,
                  effects: () => ({ unitId: null }),
                },
                unitId: {
                  order: 1,
                  required: true,
                  input: ({
                    value,
                    onChange,
                    isDisabled,
                    values: itemValues,
                  }) => (
                    <MaterialUnitSelect
                      materialId={
                        itemValues.materialId == null
                          ? null
                          : String(itemValues.materialId)
                      }
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                },
                quantity: {
                  order: 2,
                  required: true,
                  label: '净用量',
                  placeholder: '每 1 默认单位母物料',
                },
                lossRate: {
                  order: 3,
                  label: '损耗率',
                  placeholder: '空即无损耗,如 0.05',
                },
                note: { order: 4 },
              }}
              validateItem={(vals) => {
                if (!vals.materialId) return '请选择物料'
                if (!(Number(vals.quantity) > 0)) return '净用量必须大于 0'
                if (vals.lossRate != null && Number(vals.lossRate) < 0)
                  return '损耗率不能为负'
              }}
            />
          ),
          routes: (mode) => (
            <SynieEditableTable
              resource="mfgBomRoutes"
              label="工艺路线"
              items={routes}
              onChange={setRoutes}
              readOnly={mode === 'view' || (mode !== 'create' && !linesLoaded)}
              exclude={['bomId']}
              columns={['seq', 'operationId', 'requirement', 'isOutsourced']}
              fields={{
                operationId: { order: 0, required: true },
                seq: {
                  order: 1,
                  required: true,
                  placeholder: '工序顺序,如 10',
                },
                requirement: { order: 2 },
                isOutsourced: { order: 3, label: '外协', defaultValue: false },
              }}
              toolbar={
                mode === 'edit' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={!linesLoaded || routes.length > 0}
                    onPress={() => {
                      setTemplateId(null)
                      setTemplatePickerOpen(true)
                    }}
                  >
                    从模板带入
                  </Button>
                ) : mode === 'create' ? (
                  <span className="self-center text-xs text-muted">
                    保存 BOM 后可从模板带入
                  </span>
                ) : undefined
              }
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (
                  !(
                    Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0
                  )
                )
                  return '序号必须为正整数'
              }}
            />
          ),
          byproducts: (mode) => (
            <SynieEditableTable
              resource="mfgBomByproducts"
              label="副产品"
              items={byproducts}
              onChange={setByproducts}
              readOnly={mode === 'view' || (mode !== 'create' && !linesLoaded)}
              exclude={['bomId']}
              columns={['materialId', 'unitId', 'quantity', 'note']}
              fields={{
                materialId: {
                  order: 0,
                  required: true,
                  effects: () => ({ unitId: null }),
                },
                unitId: {
                  order: 1,
                  required: true,
                  input: ({
                    value,
                    onChange,
                    isDisabled,
                    values: itemValues,
                  }) => (
                    <MaterialUnitSelect
                      materialId={
                        itemValues.materialId == null
                          ? null
                          : String(itemValues.materialId)
                      }
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                },
                quantity: {
                  order: 2,
                  required: true,
                  label: '产出量',
                  placeholder: '每 1 默认单位母物料',
                },
                note: { order: 3 },
              }}
              validateItem={(vals) => {
                if (!vals.materialId) return '请选择物料'
                if (!(Number(vals.quantity) > 0)) return '产出量必须大于 0'
              }}
            />
          ),
        }}
        onSubmit={async (values, mode) => {
          const input = {
            ...values,
            // 锁定物料时表单可能只读，确保写入。
            materialId: lockedMaterialId ?? values.materialId,
            components: aggregateRows(components, componentInput),
            routes: aggregateRows(routes, routeInput),
            byproducts: aggregateRows(byproducts, byproductInput),
          }
          if (mode === 'create') {
            const createStatus = opts?.createStatus ?? 'DRAFT'
            let created: Row
            if (opts?.workOrderId) {
              const result = await createWorkOrderInlineBom(
                opts.workOrderId,
                input,
              ) as { workOrder: Row; bom: Row }
              created = result.bom
              opts.onInlineCreated?.(result)
            } else {
              created = await bomDraft.createDraft(input) as Row
              if (createStatus === 'ACTIVE') {
                const commands = resourceBindingFor('mfgBoms').commands
                if (!commands) throw new Error('BOM 启用命令未注册')
                created = await commands.execute('activate', { id: created.id }) as Row
              }
              opts?.onCreated?.(created)
            }
            toast.success(createStatus === 'ACTIVE' ? 'BOM 已创建并启用' : 'BOM 已创建')
            await resourceBindingFor('mfgBoms').cache.invalidateAll(queryClient)
            if (opts?.workOrderId) {
              await resourceBindingFor('mfgWorkOrders').cache.invalidateAll(queryClient)
            }
            setDrawer(null)
            return created.id
          } else {
            const bomId = drawer!.row!.id
            await bomDraft.replaceDraft(bomId, input)
            toast.success('BOM 已更新')
            await resourceBindingFor('mfgBoms').cache.invalidateAll(queryClient)
            return bomId
          }
        }}
      />

      <Modal.Backdrop
        isOpen={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
      >
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            <Modal.Header>
              <Modal.Heading>从模板带入工艺路线</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <RemoteSelect
                resource="mfgProcessTemplates"
                label="工艺模板"
                placeholder="选择工艺模板…"
                searchFields={['name', 'code']}
                value={templateId}
                onChange={(id) => setTemplateId(id)}
              />
              <p className="mt-2 text-xs text-muted">
                按模板步骤整路线复制为本 BOM 的工艺路线,带入后再改模板不影响本
                BOM。
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="secondary"
                onPress={() => setTemplatePickerOpen(false)}
              >
                取消
              </Button>
              <Button
                isDisabled={templateId == null}
                isPending={applying}
                onPress={() => void applyRouteTemplate()}
              >
                带入
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </BomDrawerContext.Provider>
  )
}
