import {
  createContext,
  useContext,
  useEffect,
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
import { toastError } from '~/lib/toast'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { useRequestGuard } from '~/lib/use-request-guard'

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
 *
 * @param urlSync 列表页传 true:抽屉开/关/模式走 URL search(?record=&mode=),
 *   深链/刷新/后退可寻址。工单页内嵌创建保持默认 false(纯本地态,不写宿主 URL)。
 */
export function BomDrawerProvider({
  children,
  urlSync = false,
}: {
  children: ReactNode
  urlSync?: boolean
}) {
  // URL 源(列表页)与本地态(工单内嵌)二选一;options 始终本地(不可 URL 化)
  const url = useRecordDrawerUrl('mfgBoms', { enabled: urlSync })
  const [localDrawer, setLocalDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const [options, setOptions] = useState<OpenBomDrawerOptions | undefined>()
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
  // 请求守卫:防慢响应把上一张 BOM 的明细回填到当前抽屉
  const guard = useRequestGuard()
  // 已为哪张 BOM 拉过明细;深链 effect 与 openDrawer 去重,避免双发
  const loadedBomIdRef = useRef<string | null>(null)

  const isOpen = urlSync ? url.drawer !== null : localDrawer !== null
  const mode: DrawerMode = urlSync
    ? (url.drawer?.mode ?? 'view')
    : (localDrawer?.mode ?? 'view')
  const rowId: string | undefined = urlSync
    ? (url.drawer?.recordId ?? undefined)
    : (localDrawer?.row?.id != null ? String(localDrawer.row.id) : undefined)

  function resetLines() {
    loadedBomIdRef.current = null
    setComponents([])
    setComponentsSnapshot([])
    setRoutes([])
    setRoutesSnapshot([])
    setByproducts([])
    setByproductsSnapshot([])
    setLinesLoaded(true)
  }

  function loadLinesForBom(bomId: string) {
    const my = guard.begin()
    loadedBomIdRef.current = bomId
    setLinesLoaded(false)
    const filter = {
      bomId: {
        kind: 'fk' as const,
        op: 'in' as const,
        values: [bomId],
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
        if (!guard.isCurrent(my)) return
        setComponents(componentResult.results)
        setComponentsSnapshot(componentResult.results)
        setRoutes(routeResult.results)
        setRoutesSnapshot(routeResult.results)
        setByproducts(byproductResult.results)
        setByproductsSnapshot(byproductResult.results)
        setLinesLoaded(true)
      })
      .catch((e) => {
        if (!guard.isCurrent(my)) return
        toastError('BOM 明细加载失败')(e)
        setComponents([])
        setComponentsSnapshot([])
        setRoutes([])
        setRoutesSnapshot([])
        setByproducts([])
        setByproductsSnapshot([])
      })
  }

  const closeDrawer = () => {
    setOptions(undefined)
    if (urlSync) url.close()
    else setLocalDrawer(null)
    resetLines()
  }

  const openDrawer: OpenBomDrawer = (nextMode, row, nextOptions) => {
    setOptions(nextOptions)
    if (urlSync) {
      url.open(nextMode, row?.id != null ? String(row.id) : null)
    } else {
      setLocalDrawer({ mode: nextMode, row })
    }
    if (nextMode === 'create' || !row) {
      resetLines()
      return
    }
    loadLinesForBom(String(row.id))
  }

  // 深链/前进后退:URL 驱动打开时 openDrawer 未走,按 recordId 补拉明细
  useEffect(() => {
    if (!urlSync) return
    const d = url.drawer
    if (!d) {
      // 后退关抽屉:清本地 options 与明细
      setOptions(undefined)
      if (loadedBomIdRef.current != null) resetLines()
      return
    }
    if (d.mode === 'create' || d.recordId == null) {
      if (loadedBomIdRef.current != null) resetLines()
      return
    }
    if (loadedBomIdRef.current !== d.recordId) {
      loadLinesForBom(d.recordId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 URL 抽屉身份变化时响应
  }, [urlSync, url.drawer?.recordId, url.drawer?.mode])

  async function applyRouteTemplate() {
    const bomId = rowId
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
      toastError('从模板带入失败')(e)
    } finally {
      setApplying(false)
    }
  }

  const opts = options
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
        mode={mode}
        isOpen={isOpen}
        onOpenChange={(open) => {
          if (!open) closeDrawer()
        }}
        rowId={rowId}
        onEdit={() => {
          if (urlSync) url.setMode('edit')
          else
            setLocalDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
        }}
        tabExtraContent={{
          components: (m) => (
            <SynieEditableTable
              resource="mfgBomComponents"
              label="配料"
              items={components}
              onChange={setComponents}
              readOnly={m === 'view' || (m !== 'create' && !linesLoaded)}
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
          routes: (m) => (
            <SynieEditableTable
              resource="mfgBomRoutes"
              label="工艺路线"
              items={routes}
              onChange={setRoutes}
              readOnly={m === 'view' || (m !== 'create' && !linesLoaded)}
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
                m === 'edit' ? (
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
                ) : m === 'create' ? (
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
          byproducts: (m) => (
            <SynieEditableTable
              resource="mfgBomByproducts"
              label="副产品"
              items={byproducts}
              onChange={setByproducts}
              readOnly={m === 'view' || (m !== 'create' && !linesLoaded)}
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
        onSubmit={async (values, submitMode) => {
          if (submitMode === 'create') {
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
            // 抽屉由 onOpenChange(false) 关;此处只清本地 options,避免双写 URL
            setOptions(undefined)
            loadedBomIdRef.current = null
          } else {
            const bomId = rowId
            if (!bomId) throw new Error('缺少 BOM id,无法更新')
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
