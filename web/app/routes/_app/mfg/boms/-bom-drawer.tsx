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
  bomByproductClient,
  bomClient,
  bomComponentClient,
  bomRouteClient,
} from '~/lib/resources/manufacturing'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceBindingFor } from '~/lib/resources/registry'

// mutation input 只收行自身字段,行上挂的 material/unit/operation join 对象不进 payload
function componentInput(row: Row) {
  return {
    materialId: row.materialId,
    unitId: row.unitId,
    quantity: row.quantity,
    lossRate: row.lossRate ?? null,
    note: row.note ?? null,
  }
}

function routeInput(row: Row) {
  return {
    operationId: row.operationId,
    seq: row.seq,
    requirement: row.requirement ?? null,
    isOutsourced: row.isOutsourced,
  }
}

function byproductInput(row: Row) {
  return {
    materialId: row.materialId,
    unitId: row.unitId,
    quantity: row.quantity,
    note: row.note ?? null,
  }
}

const COMPONENT_COMPARE_KEYS = [
  'materialId',
  'unitId',
  'quantity',
  'lossRate',
  'note',
] as const
const ROUTE_COMPARE_KEYS = [
  'operationId',
  'seq',
  'requirement',
  'isOutsourced',
] as const
const BYPRODUCT_COMPARE_KEYS = [
  'materialId',
  'unitId',
  'quantity',
  'note',
] as const

const rowChanged = (keys: readonly string[]) => (before: Row, after: Row) =>
  keys.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))

const componentChanged = rowChanged(COMPONENT_COMPARE_KEYS)
const routeChanged = rowChanged(ROUTE_COMPARE_KEYS)
const byproductChanged = rowChanged(BYPRODUCT_COMPARE_KEYS)

const componentLabel = (row: Row) =>
  (row.material as Row | undefined)?.name ?? '配料行'
const routeLabel = (row: Row) =>
  (row.operation as Row | undefined)?.name ?? '路线行'
const byproductLabel = (row: Row) =>
  (row.material as Row | undefined)?.name ?? '副产品行'

async function persistComponents(
  bomId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  const errors: string[] = []
  const currentIds = new Set(
    current.filter((r) => !isLocalRow(r)).map((r) => r.id),
  )

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    try {
      await bomComponentClient.delete(old.id)
    } catch (error) {
      errors.push(`${componentLabel(old)}:${(error as Error).message}`)
    }
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      try {
        await bomComponentClient.create({ bomId, ...componentInput(row) })
      } catch (error) {
        errors.push(`${componentLabel(row)}:${(error as Error).message}`)
      }
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && componentChanged(old, row)) {
      try {
        await bomComponentClient.update(row.id, componentInput(row))
      } catch (error) {
        errors.push(`${componentLabel(row)}:${(error as Error).message}`)
      }
    }
  }
  return errors
}

async function persistRoutes(
  bomId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  const errors: string[] = []
  const currentIds = new Set(
    current.filter((r) => !isLocalRow(r)).map((r) => r.id),
  )

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    try {
      await bomRouteClient.delete(old.id)
    } catch (error) {
      errors.push(`${routeLabel(old)}:${(error as Error).message}`)
    }
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      try {
        await bomRouteClient.create({ bomId, ...routeInput(row) })
      } catch (error) {
        errors.push(`${routeLabel(row)}:${(error as Error).message}`)
      }
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && routeChanged(old, row)) {
      try {
        await bomRouteClient.update(row.id, routeInput(row))
      } catch (error) {
        errors.push(`${routeLabel(row)}:${(error as Error).message}`)
      }
    }
  }
  return errors
}

async function persistByproducts(
  bomId: string,
  current: Row[],
  snapshot: Row[],
): Promise<string[]> {
  const errors: string[] = []
  const currentIds = new Set(
    current.filter((r) => !isLocalRow(r)).map((r) => r.id),
  )

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    try {
      await bomByproductClient.delete(old.id)
    } catch (error) {
      errors.push(`${byproductLabel(old)}:${(error as Error).message}`)
    }
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      try {
        await bomByproductClient.create({ bomId, ...byproductInput(row) })
      } catch (error) {
        errors.push(`${byproductLabel(row)}:${(error as Error).message}`)
      }
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && byproductChanged(old, row)) {
      try {
        await bomByproductClient.update(row.id, byproductInput(row))
      } catch (error) {
        errors.push(`${byproductLabel(row)}:${(error as Error).message}`)
      }
    }
  }
  return errors
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
  /** create 成功（头+明细已尽量落库）后回调，供工单 form 回填 bomId */
  onCreated?: (bom: Row) => void
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
  const [componentsSnapshot, setComponentsSnapshot] = useState<Row[]>([])
  const [routes, setRoutes] = useState<Row[]>([])
  const [routesSnapshot, setRoutesSnapshot] = useState<Row[]>([])
  const [byproducts, setByproducts] = useState<Row[]>([])
  const [byproductsSnapshot, setByproductsSnapshot] = useState<Row[]>([])
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
      setComponentsSnapshot([])
      setRoutes([])
      setRoutesSnapshot([])
      setByproducts([])
      setByproductsSnapshot([])
      setLinesLoaded(true)
      return
    }
    setLinesLoaded(false)
    const filter = {
      bomId: {
        kind: 'fk' as const,
        op: 'in' as const,
        values: [row.id],
        labels: [],
      },
    }
    Promise.all([
      bomComponentClient.query({ limit: 200, offset: 0, filter }),
      bomRouteClient.query({
        limit: 200,
        offset: 0,
        filter,
        sort: { column: 'seq', direction: 'ascending' },
      }),
      bomByproductClient.query({ limit: 200, offset: 0, filter }),
    ])
      .then(([componentResult, routeResult, byproductResult]) => {
        if (my !== reqIdRef.current) return
        setComponents(componentResult.results)
        setComponentsSnapshot(componentResult.results)
        setRoutes(routeResult.results)
        setRoutesSnapshot(routeResult.results)
        setByproducts(byproductResult.results)
        setByproductsSnapshot(byproductResult.results)
        setLinesLoaded(true)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('BOM 明细加载失败', { description: (e as Error).message })
        setComponents([])
        setComponentsSnapshot([])
        setRoutes([])
        setRoutesSnapshot([])
        setByproducts([])
        setByproductsSnapshot([])
      })
  }

  async function applyRouteTemplate() {
    const bomId = drawer?.row?.id
    if (!bomId || templateId == null) return
    setApplying(true)
    try {
      await applyBomRouteTemplate(bomId, templateId)
      const result = await bomRouteClient.query({
        limit: 200,
        offset: 0,
        filter: {
          bomId: {
            kind: 'fk',
            op: 'in',
            values: [bomId],
            labels: [],
          },
        },
        sort: { column: 'seq', direction: 'ascending' },
      })
      setRoutes(result.results)
      setRoutesSnapshot(result.results)
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
          if (mode === 'create') {
            const createStatus = opts?.createStatus ?? 'DRAFT'
            const created = (await bomClient.create({
              ...values,
              // 锁定物料时表单可能只读，确保写入
              materialId: lockedMaterialId ?? values.materialId,
              status: createStatus,
            })) as Row
            const bomId = String(created.id)
            const lineErrors = [
              ...(await persistComponents(bomId, components, [])),
              ...(await persistRoutes(bomId, routes, [])),
              ...(await persistByproducts(bomId, byproducts, [])),
            ]
            if (lineErrors.length > 0) {
              toast.danger('BOM 已创建,但部分明细行保存失败', {
                description: lineErrors.join('; '),
              })
            } else {
              toast.success(
                createStatus === 'ACTIVE'
                  ? 'BOM 已创建并启用'
                  : 'BOM 已创建',
              )
            }
            opts?.onCreated?.(created)
            setDrawer(null)
          } else {
            const bomId = drawer!.row!.id
            await bomClient.update(bomId, values)
            const lineErrors = [
              ...(await persistComponents(
                bomId,
                components,
                componentsSnapshot,
              )),
              ...(await persistRoutes(bomId, routes, routesSnapshot)),
              ...(await persistByproducts(
                bomId,
                byproducts,
                byproductsSnapshot,
              )),
            ]
            if (lineErrors.length > 0) {
              toast.danger('BOM 已更新,但部分明细行保存失败', {
                description: lineErrors.join('; '),
              })
            } else {
              toast.success('BOM 已更新')
            }
          }
          await resourceBindingFor('mfgBoms').cache.invalidateAll(queryClient)
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
