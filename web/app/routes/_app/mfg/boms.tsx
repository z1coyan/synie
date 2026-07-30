import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Link, Modal, toast } from '@heroui/react'
import {
  SynieDataGrid,
  type ColumnOverride,
} from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import {
  applyRouteTemplate as applyBomRouteTemplate,
  bomByproductClient,
  bomClient,
  bomComponentClient,
  bomRouteClient,
} from '~/lib/resources/manufacturing'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/boms')({
  component: BomsPage,
})

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

/** 配料行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy(同物料单位转换先例) */
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

/** 工艺路线行差异持久化(同配料行先例) */
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

/** 副产品行差异持久化(同配料行先例) */
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

// 列白名单:编号/方案名称区分同物料多张;物料走 fk 列(join 展开编号/名称/规格),时间戳不进表格
const GRID_COLUMNS = ['code', 'materialId', 'planName', 'note']

/** 物料列:「编号-名称(规格)」,点击开物料速览(join 默认只取 id/name,code/spec 经 joinFields 追加取回,同物料分类列先例) */
function MaterialCell({ row }: { row: Row }) {
  const openPreview = useFkPreview()
  const id =
    row.materialId == null || row.materialId === ''
      ? null
      : String(row.materialId)
  const material = (row.material as Row | null | undefined) ?? null
  if (!id) return <span className="text-muted">—</span>
  // join 缺失(物料读权限被裁剪):退截断 id,不给点不开的 link
  if (!material) return <>{id.slice(0, 8)}</>
  const text = [material.code, material.name]
    .filter((s) => s != null && s !== '')
    .join('-')
  return (
    <Link
      onPress={() => openPreview('invMaterials', String(material.id ?? id))}
      className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
    >
      {text}
      {material.spec != null && material.spec !== '' && (
        <span className="text-muted">({String(material.spec)})</span>
      )}
    </Link>
  )
}

// 模块级稳定引用:内联对象会让 SynieDataGrid 的列 memo 每次渲染失效
// 卡片:物料标题、BOM 编号副标题、方案名称摘要
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  materialId: {
    label: '物料',
    mobileRole: 'title',
    render: (_value, row) => <MaterialCell row={row} />,
  },
  code: { mobileRole: 'subtitle' },
  planName: { mobileRole: 'summary' },
}

function BomsPage() {
  const [drawer, setDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)
  const [components, setComponents] = useState<Row[]>([])
  const [componentsSnapshot, setComponentsSnapshot] = useState<Row[]>([])
  const [routes, setRoutes] = useState<Row[]>([])
  const [routesSnapshot, setRoutesSnapshot] = useState<Row[]>([])
  const [byproducts, setByproducts] = useState<Row[]>([])
  const [byproductsSnapshot, setByproductsSnapshot] = useState<Row[]>([])
  // edit/view 态三个子表靠 FETCH_LINES 异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [linesLoaded, setLinesLoaded] = useState(false)
  // 「从模板带入」弹窗:仅 edit 态且无路线行时入口可用(后端 NoRoutes 校验兜底)
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const queryClient = useQueryClient()
  // 请求守卫:防止慢响应把上一张 BOM 的行回填到当前 BOM(同物料先例)
  const reqIdRef = useRef(0)

  // 打开抽屉:create 清空三个子表;view/edit 按 BOM id 拉行(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
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

  // 从模板带入工艺路线:仅当前 BOM 无路线行时入口可用(后端 NoRoutes 兜底);带入后重拉路线行
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

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">BOM</h1>
      <p className="mt-2 text-sm text-ink-500">
        物料清单(单层配方):同一物料可建多张,凭编号/方案名称区分;配料含净用量与损耗率;工艺路线可手录或从工艺模板带入;副产品为联产出声明。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgBoms"
          client={bomClient}
          columns={GRID_COLUMNS}
          joinFields={{ material: ['code', 'spec'] }}
          overrides={GRID_OVERRIDES}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource="mfgBoms"
        client={bomClient}
        {...drawerConfig('mfgBoms')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        tabExtraContent={{
          components: (mode) => (
            <SynieEditableTable
              resource="mfgBomComponents"
              client={bomComponentClient}
              label="配料"
              items={components}
              onChange={setComponents}
              readOnly={mode === 'view' || (mode !== 'create' && !linesLoaded)}
              exclude={['bomId']}
              columns={['materialId', 'unitId', 'quantity', 'lossRate', 'note']}
              fields={{
                // 切换物料时清掉已选单位,避免单位候选跟着旧物料走(同订单条目先例)
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
              client={bomRouteClient}
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
                    // 已有路线行时置灰:模板带入是整路线复制,不与手录行混排(后端 NoRoutes 兜底)
                    isDisabled={!linesLoaded || routes.length > 0}
                    onPress={() => {
                      setTemplateId(null)
                      setTemplatePickerOpen(true)
                    }}
                  >
                    从模板带入
                  </Button>
                ) : mode === 'create' ? (
                  // BOM 需先保存才有宿主 id,模板带入留到编辑态
                  <span className="self-center text-xs text-muted">
                    保存 BOM 后可从模板带入
                  </span>
                ) : undefined
              }
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (!(
                  Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0
                ))
                  return '序号必须为正整数'
              }}
            />
          ),
          byproducts: (mode) => (
            <SynieEditableTable
              resource="mfgBomByproducts"
              client={bomByproductClient}
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
            const created = await bomClient.create(values)
            const bomId = created.id
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
              toast.success('BOM 已创建')
            }
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
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'mfgBoms'] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'mfgBoms'] })
        }}
      />

      {/* 从模板带入:选工艺模板复制为本 BOM 私行(快照语义,带入后与模板脱钩) */}
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
    </>
  )
}
