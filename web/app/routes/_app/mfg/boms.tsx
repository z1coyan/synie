import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Link, Modal, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'
import { MaterialUnitSelect } from '~/components/synie-material-unit-select/MaterialUnitSelect'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/mfg/boms')({
  component: BomsPage,
})

const CREATE_BOM = `
  mutation ($input: CreateMfgBomInput!) {
    createMfgBom(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_BOM = `
  mutation ($id: ID!, $input: UpdateMfgBomInput!) {
    updateMfgBom(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 三个子表一发拉齐:配料/副产品按录入序、工艺路线按工序顺序
const FETCH_LINES = `
  query ($bomId: ID!) {
    mfgBomComponents(filter: {bomId: {eq: $bomId}}, sort: [{field: INSERTED_AT, order: ASC}], limit: 200, offset: 0) {
      results { id materialId unitId quantity lossRate note material { id code name } unit { id name } }
    }
    mfgBomRoutes(filter: {bomId: {eq: $bomId}}, sort: [{field: SEQ, order: ASC}], limit: 200, offset: 0) {
      results { id operationId seq requirement isOutsourced operation { id code name } }
    }
    mfgBomByproducts(filter: {bomId: {eq: $bomId}}, sort: [{field: INSERTED_AT, order: ASC}], limit: 200, offset: 0) {
      results { id materialId unitId quantity note material { id code name } unit { id name } }
    }
  }
`
// 「从模板带入」成功后单拉路线行刷新表格(快照一并重置,带入行即新基准)
const FETCH_ROUTES = `
  query ($bomId: ID!) {
    mfgBomRoutes(filter: {bomId: {eq: $bomId}}, sort: [{field: SEQ, order: ASC}], limit: 200, offset: 0) {
      results { id operationId seq requirement isOutsourced operation { id code name } }
    }
  }
`
const APPLY_ROUTE_TEMPLATE = `
  mutation ($id: ID!, $input: ApplyMfgBomRouteTemplateInput!) {
    applyMfgBomRouteTemplate(id: $id, input: $input) { result { id } errors { message } }
  }
`
const CREATE_COMPONENT = `
  mutation ($input: CreateMfgBomComponentInput!) {
    createMfgBomComponent(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_COMPONENT = `
  mutation ($id: ID!, $input: UpdateMfgBomComponentInput!) {
    updateMfgBomComponent(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_COMPONENT = `
  mutation ($id: ID!) {
    destroyMfgBomComponent(id: $id) { errors { message } }
  }
`
const CREATE_ROUTE = `
  mutation ($input: CreateMfgBomRouteInput!) {
    createMfgBomRoute(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_ROUTE = `
  mutation ($id: ID!, $input: UpdateMfgBomRouteInput!) {
    updateMfgBomRoute(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_ROUTE = `
  mutation ($id: ID!) {
    destroyMfgBomRoute(id: $id) { errors { message } }
  }
`
const CREATE_BYPRODUCT = `
  mutation ($input: CreateMfgBomByproductInput!) {
    createMfgBomByproduct(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_BYPRODUCT = `
  mutation ($id: ID!, $input: UpdateMfgBomByproductInput!) {
    updateMfgBomByproduct(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_BYPRODUCT = `
  mutation ($id: ID!) {
    destroyMfgBomByproduct(id: $id) { errors { message } }
  }
`

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

const COMPONENT_COMPARE_KEYS = ['materialId', 'unitId', 'quantity', 'lossRate', 'note'] as const
const ROUTE_COMPARE_KEYS = ['operationId', 'seq', 'requirement', 'isOutsourced'] as const
const BYPRODUCT_COMPARE_KEYS = ['materialId', 'unitId', 'quantity', 'note'] as const

const rowChanged = (keys: readonly string[]) => (before: Row, after: Row) =>
  keys.some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))

const componentChanged = rowChanged(COMPONENT_COMPARE_KEYS)
const routeChanged = rowChanged(ROUTE_COMPARE_KEYS)
const byproductChanged = rowChanged(BYPRODUCT_COMPARE_KEYS)

const componentLabel = (row: Row) => (row.material as Row | undefined)?.name ?? '配料行'
const routeLabel = (row: Row) => (row.operation as Row | undefined)?.name ?? '路线行'
const byproductLabel = (row: Row) => (row.material as Row | undefined)?.name ?? '副产品行'

/** 配料行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy(同物料单位转换先例) */
async function persistComponents(bomId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyMfgBomComponent: { errors: { message: string }[] | null } }>(
      DESTROY_COMPONENT,
      { id: old.id }
    )
    collect(componentLabel(old), data.destroyMfgBomComponent.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createMfgBomComponent: { errors: { message: string }[] | null } }>(
        CREATE_COMPONENT,
        { input: { bomId, ...componentInput(row) } }
      )
      collect(componentLabel(row), data.createMfgBomComponent.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && componentChanged(old, row)) {
      const data = await gqlFetch<{ updateMfgBomComponent: { errors: { message: string }[] | null } }>(
        UPDATE_COMPONENT,
        { id: row.id, input: componentInput(row) }
      )
      collect(componentLabel(row), data.updateMfgBomComponent.errors)
    }
  }
  return errors
}

/** 工艺路线行差异持久化(同配料行先例) */
async function persistRoutes(bomId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyMfgBomRoute: { errors: { message: string }[] | null } }>(
      DESTROY_ROUTE,
      { id: old.id }
    )
    collect(routeLabel(old), data.destroyMfgBomRoute.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createMfgBomRoute: { errors: { message: string }[] | null } }>(
        CREATE_ROUTE,
        { input: { bomId, ...routeInput(row) } }
      )
      collect(routeLabel(row), data.createMfgBomRoute.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && routeChanged(old, row)) {
      const data = await gqlFetch<{ updateMfgBomRoute: { errors: { message: string }[] | null } }>(
        UPDATE_ROUTE,
        { id: row.id, input: routeInput(row) }
      )
      collect(routeLabel(row), data.updateMfgBomRoute.errors)
    }
  }
  return errors
}

/** 副产品行差异持久化(同配料行先例) */
async function persistByproducts(bomId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyMfgBomByproduct: { errors: { message: string }[] | null } }>(
      DESTROY_BYPRODUCT,
      { id: old.id }
    )
    collect(byproductLabel(old), data.destroyMfgBomByproduct.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createMfgBomByproduct: { errors: { message: string }[] | null } }>(
        CREATE_BYPRODUCT,
        { input: { bomId, ...byproductInput(row) } }
      )
      collect(byproductLabel(row), data.createMfgBomByproduct.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && byproductChanged(old, row)) {
      const data = await gqlFetch<{ updateMfgBomByproduct: { errors: { message: string }[] | null } }>(
        UPDATE_BYPRODUCT,
        { id: row.id, input: byproductInput(row) }
      )
      collect(byproductLabel(row), data.updateMfgBomByproduct.errors)
    }
  }
  return errors
}

// 列白名单:物料走 fk 列(join 展开编号/名称/规格),时间戳不进表格
const GRID_COLUMNS = ['materialId', 'note']

/** 物料列:「编号-名称(规格)」,点击开物料速览(join 默认只取 id/name,code/spec 经 joinFields 追加取回,同物料分类列先例) */
function MaterialCell({ row }: { row: Row }) {
  const openPreview = useFkPreview()
  const id = row.materialId == null || row.materialId === '' ? null : String(row.materialId)
  const material = (row.material as Row | null | undefined) ?? null
  if (!id) return <span className="text-muted">—</span>
  // join 缺失(物料读权限被裁剪):退截断 id,不给点不开的 link
  if (!material) return <>{id.slice(0, 8)}</>
  const text = [material.code, material.name].filter((s) => s != null && s !== '').join('-')
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
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  materialId: { label: '物料', render: (_value, row) => <MaterialCell row={row} /> },
}

function BomsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
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
    gqlFetch<{
      mfgBomComponents: { results: Row[] }
      mfgBomRoutes: { results: Row[] }
      mfgBomByproducts: { results: Row[] }
    }>(FETCH_LINES, { bomId: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setComponents(d.mfgBomComponents.results)
        setComponentsSnapshot(d.mfgBomComponents.results)
        setRoutes(d.mfgBomRoutes.results)
        setRoutesSnapshot(d.mfgBomRoutes.results)
        setByproducts(d.mfgBomByproducts.results)
        setByproductsSnapshot(d.mfgBomByproducts.results)
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
      const data = await gqlFetch<{ applyMfgBomRouteTemplate: { errors: { message: string }[] | null } }>(
        APPLY_ROUTE_TEMPLATE,
        { id: bomId, input: { templateId } }
      )
      if (data.applyMfgBomRouteTemplate.errors && data.applyMfgBomRouteTemplate.errors.length > 0) {
        toast.danger('从模板带入失败', {
          description: data.applyMfgBomRouteTemplate.errors.map((e) => e.message).join('; '),
        })
        return
      }
      const d = await gqlFetch<{ mfgBomRoutes: { results: Row[] } }>(FETCH_ROUTES, { bomId })
      setRoutes(d.mfgBomRoutes.results)
      setRoutesSnapshot(d.mfgBomRoutes.results)
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
        物料清单(单层配方):一物料至多一张,配料含净用量与损耗率;工艺路线可手录或从工艺模板带入;副产品为联产出声明。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="mfgBoms"
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
              label="配料"
              items={components}
              onChange={setComponents}
              readOnly={mode === 'view' || (mode !== 'create' && !linesLoaded)}
              exclude={['bomId']}
              columns={['materialId', 'unitId', 'quantity', 'lossRate', 'note']}
              fields={{
                // 切换物料时清掉已选单位,避免单位候选跟着旧物料走(同订单条目先例)
                materialId: { order: 0, required: true, effects: () => ({ unitId: null }) },
                unitId: {
                  order: 1,
                  required: true,
                  input: ({ value, onChange, isDisabled, values: itemValues }) => (
                    <MaterialUnitSelect
                      materialId={itemValues.materialId == null ? null : String(itemValues.materialId)}
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                },
                quantity: { order: 2, required: true, label: '净用量', placeholder: '每 1 默认单位母物料' },
                lossRate: { order: 3, label: '损耗率', placeholder: '空即无损耗,如 0.05' },
                note: { order: 4 },
              }}
              validateItem={(vals) => {
                if (!vals.materialId) return '请选择物料'
                if (!(Number(vals.quantity) > 0)) return '净用量必须大于 0'
                if (vals.lossRate != null && Number(vals.lossRate) < 0) return '损耗率不能为负'
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
                seq: { order: 1, required: true, placeholder: '工序顺序,如 10' },
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
                  <span className="self-center text-xs text-muted">保存 BOM 后可从模板带入</span>
                ) : undefined
              }
              validateItem={(vals) => {
                if (!vals.operationId) return '请选择工序'
                if (!(Number.isInteger(Number(vals.seq)) && Number(vals.seq) > 0)) return '序号必须为正整数'
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
                materialId: { order: 0, required: true, effects: () => ({ unitId: null }) },
                unitId: {
                  order: 1,
                  required: true,
                  input: ({ value, onChange, isDisabled, values: itemValues }) => (
                    <MaterialUnitSelect
                      materialId={itemValues.materialId == null ? null : String(itemValues.materialId)}
                      value={value}
                      onChange={onChange}
                      isDisabled={isDisabled}
                    />
                  ),
                },
                quantity: { order: 2, required: true, label: '产出量', placeholder: '每 1 默认单位母物料' },
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
            const data = await gqlFetch<{
              createMfgBom: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_BOM, { input: values })
            if (data.createMfgBom.errors && data.createMfgBom.errors.length > 0) {
              throw new Error(data.createMfgBom.errors.map((e) => e.message).join('; '))
            }
            const bomId = data.createMfgBom.result!.id
            const lineErrors = [
              ...(await persistComponents(bomId, components, [])),
              ...(await persistRoutes(bomId, routes, [])),
              ...(await persistByproducts(bomId, byproducts, [])),
            ]
            if (lineErrors.length > 0) {
              toast.danger('BOM 已创建,但部分明细行保存失败', { description: lineErrors.join('; ') })
            } else {
              toast.success('BOM 已创建')
            }
          } else {
            const bomId = drawer!.row!.id
            const data = await gqlFetch<{ updateMfgBom: { errors: { message: string }[] | null } }>(
              UPDATE_BOM,
              { id: bomId, input: values }
            )
            if (data.updateMfgBom.errors && data.updateMfgBom.errors.length > 0) {
              throw new Error(data.updateMfgBom.errors.map((e) => e.message).join('; '))
            }
            const lineErrors = [
              ...(await persistComponents(bomId, components, componentsSnapshot)),
              ...(await persistRoutes(bomId, routes, routesSnapshot)),
              ...(await persistByproducts(bomId, byproducts, byproductsSnapshot)),
            ]
            if (lineErrors.length > 0) {
              toast.danger('BOM 已更新,但部分明细行保存失败', { description: lineErrors.join('; ') })
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
      <Modal.Backdrop isOpen={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
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
                按模板步骤整路线复制为本 BOM 的工艺路线,带入后再改模板不影响本 BOM。
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setTemplatePickerOpen(false)}>
                取消
              </Button>
              <Button isDisabled={templateId == null} isPending={applying} onPress={() => void applyRouteTemplate()}>
                带入
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
