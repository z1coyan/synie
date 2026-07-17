import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { attachFile, type UploadedFile } from '~/lib/files'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/materials')({
  component: MaterialsPage,
})

const CREATE_MATERIAL = `
  mutation ($input: CreateInvMaterialInput!) {
    createInvMaterial(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_MATERIAL = `
  mutation ($id: ID!, $input: UpdateInvMaterialInput!) {
    updateInvMaterial(id: $id, input: $input) { result { id } errors { message } }
  }
`
const FETCH_UNITS = `
  query ($materialId: ID!) {
    invMaterialUnits(filter: {materialId: {eq: $materialId}}, sort: [{field: INSERTED_AT, order: ASC}], limit: 200, offset: 0) {
      results { id unitId factor unit { id name symbol } }
    }
  }
`
const CREATE_UNIT = `
  mutation ($input: CreateInvMaterialUnitInput!) {
    createInvMaterialUnit(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_UNIT = `
  mutation ($id: ID!, $input: UpdateInvMaterialUnitInput!) {
    updateInvMaterialUnit(id: $id, input: $input) { result { id } errors { message } }
  }
`
const DESTROY_UNIT = `
  mutation ($id: ID!) {
    destroyInvMaterialUnit(id: $id) { errors { message } }
  }
`

// mutation input 只收行自身字段,行上挂的 unit join 对象不进 payload
function unitInput(row: Row) {
  return { unitId: row.unitId, factor: row.factor }
}

function unitChanged(before: Row, after: Row): boolean {
  return ['unitId', 'factor'].some((k) => String(before[k] ?? '') !== String(after[k] ?? ''))
}

/** 转换行差异持久化:本地草稿行 create;存量行有变 update;快照有、当前无 destroy(同凭证分录行先例) */
async function persistUnits(materialId: string, current: Row[], snapshot: Row[]): Promise<string[]> {
  const errors: string[] = []
  const collect = (label: unknown, msgs: { message: string }[] | null | undefined) => {
    if (msgs?.length) errors.push(...msgs.map((e) => `${label}:${e.message}`))
  }
  const unitLabel = (row: Row) => (row.unit as Row | undefined)?.name ?? '转换行'
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    const data = await gqlFetch<{ destroyInvMaterialUnit: { errors: { message: string }[] | null } }>(
      DESTROY_UNIT,
      { id: old.id }
    )
    collect(unitLabel(old), data.destroyInvMaterialUnit.errors)
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      const data = await gqlFetch<{ createInvMaterialUnit: { errors: { message: string }[] | null } }>(
        CREATE_UNIT,
        { input: { materialId, ...unitInput(row) } }
      )
      collect(unitLabel(row), data.createInvMaterialUnit.errors)
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && unitChanged(old, row)) {
      const data = await gqlFetch<{ updateInvMaterialUnit: { errors: { message: string }[] | null } }>(
        UPDATE_UNIT,
        { id: row.id, input: unitInput(row) }
      )
      collect(unitLabel(row), data.updateInvMaterialUnit.errors)
    }
  }
  return errors
}

// 常用列白名单:时间戳不进表格,图纸走 attachmentImages 虚拟列
const GRID_COLUMNS = ['code', 'name', 'categoryId', 'spec', 'customerPartNo', 'defaultUnitId', 'active']

function MaterialsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [units, setUnits] = useState<Row[]>([])
  const [unitsSnapshot, setUnitsSnapshot] = useState<Row[]>([])
  // 创建态暂存附件(图纸/其他文件两槽位分开):先传裸文件,创建成功后统一挂接;抽屉重开即清空
  const [pendingDrawings, setPendingDrawings] = useState<UploadedFile[]>([])
  const [pendingOthers, setPendingOthers] = useState<UploadedFile[]>([])
  const queryClient = useQueryClient()
  // 请求守卫:防止慢响应把上一条物料的转换行回填到当前物料(同凭证页先例)
  const reqIdRef = useRef(0)

  // 打开抽屉:create 清空转换行与暂存附件;view/edit 按物料 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create' || !row) {
      setUnits([])
      setUnitsSnapshot([])
      setPendingDrawings([])
      setPendingOthers([])
      return
    }
    gqlFetch<{ invMaterialUnits: { results: Row[] } }>(FETCH_UNITS, { materialId: row.id })
      .then((d) => {
        if (my !== reqIdRef.current) return
        setUnits(d.invMaterialUnits.results)
        setUnitsSnapshot(d.invMaterialUnits.results)
      })
      .catch((e) => {
        if (my !== reqIdRef.current) return
        toast.danger('单位转换加载失败', { description: (e as Error).message })
        setUnits([])
        setUnitsSnapshot([])
      })
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">物料管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        全局共享的物料主数据:编号留空按「分类号-序号」自动生成,图纸、其他文件与单位转换建料时即可一并录入。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="invMaterials"
          columns={GRID_COLUMNS}
          attachmentImages={{ ownerType: 'inv_material', category: 'drawing', label: '图纸' }}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
        />
      </div>

      <SynieRecordDrawer
        resource="invMaterials"
        {...drawerConfig('invMaterials')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        extraContent={(mode, row, values) => {
          // 默认单位:编辑态取表单草稿(可能刚改),view 态取行数据;转换行不能选它
          const defaultUnitId = ((values.defaultUnitId ?? row?.defaultUnitId) as string | null) ?? null
          return (
            <div className="flex flex-col gap-4">
              <SynieEditableTable
                resource="invMaterialUnits"
                label="单位转换"
                items={units}
                onChange={setUnits}
                readOnly={mode === 'view'}
                exclude={['materialId']}
                columns={['unitId', 'factor']}
                fields={{
                  // 录入顺序:先选单位再填系数(meta 列序 factor 在前,这里显式调换)
                  unitId: { order: 0, required: true },
                  factor: { order: 1, required: true, placeholder: '1 默认单位 = x 该单位,如 518' },
                }}
                validateItem={(vals, items, editing) => {
                  if (defaultUnitId && vals.unitId === defaultUnitId) return '转换单位不能与默认单位相同'
                  if (!(Number(vals.factor) > 0)) return '换算系数必须大于 0'
                  if (items.some((r) => r.id !== editing?.id && r.unitId === vals.unitId)) return '该单位已有转换行'
                }}
              />
              <SynieAttachmentPanel
                ownerType="inv_material"
                ownerId={row?.id as string | undefined}
                category="drawing"
                label="图纸"
                accept="image/*"
                readonly={mode === 'view'}
                // 创建态走暂存,保存成功后按槽位统一挂接
                pending={
                  mode === 'create'
                    ? {
                        files: pendingDrawings,
                        onAdd: (f) => setPendingDrawings((fs) => [...fs, f]),
                        onRemove: (id) => setPendingDrawings((fs) => fs.filter((f) => f.id !== id)),
                      }
                    : undefined
                }
              />
              <SynieAttachmentPanel
                ownerType="inv_material"
                ownerId={row?.id as string | undefined}
                category="default"
                label="其他文件"
                readonly={mode === 'view'}
                pending={
                  mode === 'create'
                    ? {
                        files: pendingOthers,
                        onAdd: (f) => setPendingOthers((fs) => [...fs, f]),
                        onRemove: (id) => setPendingOthers((fs) => fs.filter((f) => f.id !== id)),
                      }
                    : undefined
                }
              />
            </div>
          )
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const data = await gqlFetch<{
              createInvMaterial: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_MATERIAL, { input: values })
            if (data.createInvMaterial.errors && data.createInvMaterial.errors.length > 0) {
              throw new Error(data.createInvMaterial.errors.map((e) => e.message).join('; '))
            }
            const materialId = data.createInvMaterial.result!.id
            const unitErrors = await persistUnits(materialId, units, [])
            // 暂存附件按槽位统一挂接;个别失败不阻断建料,提示手工补传即可
            const failed: string[] = []
            for (const { file, category } of [
              ...pendingDrawings.map((file) => ({ file, category: 'drawing' })),
              ...pendingOthers.map((file) => ({ file, category: 'default' })),
            ]) {
              try {
                await attachFile(file.id, { ownerType: 'inv_material', ownerId: materialId, category })
              } catch {
                failed.push(file.filename)
              }
            }
            if (failed.length > 0) {
              toast.warning(`物料已创建,但附件挂接失败:${failed.join('、')},请在详情附件区手工补传`)
            }
            if (unitErrors.length > 0) {
              toast.danger('物料已创建,但部分单位转换保存失败', { description: unitErrors.join('; ') })
            } else if (failed.length === 0) {
              toast.success('物料已创建')
            }
          } else {
            const materialId = drawer!.row!.id
            const data = await gqlFetch<{ updateInvMaterial: { errors: { message: string }[] | null } }>(
              UPDATE_MATERIAL,
              { id: materialId, input: values }
            )
            if (data.updateInvMaterial.errors && data.updateInvMaterial.errors.length > 0) {
              throw new Error(data.updateInvMaterial.errors.map((e) => e.message).join('; '))
            }
            const unitErrors = await persistUnits(materialId, units, unitsSnapshot)
            if (unitErrors.length > 0) {
              toast.danger('物料已更新,但部分单位转换保存失败', { description: unitErrors.join('; ') })
            } else {
              toast.success('物料已更新')
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'invMaterials'] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'invMaterials'] })
        }}
      />
    </>
  )
}
