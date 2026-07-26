import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, toast } from '@heroui/react'
import { materialClient, materialUnitClient } from '~/lib/resources/inventory'
import { unitClient } from '~/lib/resources/units'
import { attachFile, type UploadedFile } from '~/lib/files'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieEditableTable } from '~/components/synie-editable-table/SynieEditableTable'
import { isLocalRow } from '~/components/synie-editable-table/editable'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import { useFkPreview } from '~/components/synie-record-drawer/fk-preview'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/scm/materials')({
  component: MaterialsPage,
})

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
  const unitLabel = (row: Row) => (row.unit as Row | undefined)?.name ?? '转换行'
  const attempt = async (row: Row, operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      errors.push(`${unitLabel(row)}:${(error as Error).message}`)
    }
  }
  const currentIds = new Set(current.filter((r) => !isLocalRow(r)).map((r) => r.id))

  for (const old of snapshot) {
    if (currentIds.has(old.id)) continue
    await attempt(old, () => materialUnitClient.delete(old.id))
  }

  for (const row of current) {
    if (isLocalRow(row)) {
      await attempt(row, () => materialUnitClient.create({ materialId, ...unitInput(row) }))
      continue
    }
    const old = snapshot.find((s) => s.id === row.id)
    if (old && unitChanged(old, row)) {
      await attempt(row, () => materialUnitClient.update(row.id, unitInput(row)))
    }
  }
  return errors
}


// 常用列白名单:时间戳不进表格,图纸走 attachmentImages 虚拟列;分类列置顶
const GRID_COLUMNS = [
  'categoryId',
  'code',
  'name',
  'spec',
  'isCustomerMaterial',
  'customerId',
  'customerPartNo',
  'defaultUnitId',
  'active',
]

/** 分类列单元格:「分类编号-分类名称」,点击开分类速览(join 默认只取 id/name,code 经 joinFields 追加取回) */
function CategoryCell({ row }: { row: Row }) {
  const openPreview = useFkPreview()
  const id = row.categoryId == null || row.categoryId === '' ? null : String(row.categoryId)
  const cat = (row.category as Row | null | undefined) ?? null
  if (!id) return <span className="text-muted">—</span>
  // join 缺失(分类读权限被裁剪):退截断 id,不给点不开的 link
  if (!cat) return <>{id.slice(0, 8)}</>
  const text = [cat.code, cat.name].filter((s) => s != null && s !== '').join('-')
  return (
    <Link
      onPress={() => openPreview('invMaterialCategories', String(cat.id ?? id))}
      className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
    >
      {text}
    </Link>
  )
}

function MaterialsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [units, setUnits] = useState<Row[]>([])
  const [unitsSnapshot, setUnitsSnapshot] = useState<Row[]>([])
  // edit/view 态单位转换靠 FETCH_UNITS 异步拉取,未完成前禁止编辑,防回填覆盖在输行
  const [unitsLoaded, setUnitsLoaded] = useState(false)
  // 创建态暂存附件(图纸/其他文件两槽位分开):先传裸文件,创建成功后统一挂接;抽屉重开即清空
  const [pendingDrawings, setPendingDrawings] = useState<UploadedFile[]>([])
  const [pendingOthers, setPendingOthers] = useState<UploadedFile[]>([])
  const queryClient = useQueryClient()
  // 请求守卫:防止慢响应把上一条物料的转换行回填到当前物料(同凭证页先例)
  const reqIdRef = useRef(0)

  // 单位名称表:单位转换 tab 的「基准单位」提示按默认单位 id 反查名称
  const { data: unitNames } = useQuery({
    queryKey: ['basUnitNames'],
    queryFn: () =>
      unitClient.query({
        limit: 200,
        offset: 0,
        sort: { column: 'name', direction: 'ascending' },
      }).then((result) => result.results),
    enabled: drawer !== null,
    staleTime: 60_000,
  })

  // 打开抽屉:create 清空转换行与暂存附件;view/edit 按物料 id 拉行(快照留作提交时 diff 基准)
  const openDrawer = (mode: DrawerMode, row: Row | null) => {
    const my = ++reqIdRef.current
    setDrawer({ mode, row })
    if (mode === 'create' || !row) {
      setUnits([])
      setUnitsSnapshot([])
      setPendingDrawings([])
      setPendingOthers([])
      setUnitsLoaded(true)
      return
    }
    setUnitsLoaded(false)
    materialUnitClient.query({
      limit: 200,
      offset: 0,
      sort: { column: 'insertedAt', direction: 'ascending' },
      filter: { materialId: { kind: 'fk', op: 'in', values: [row.id], labels: [] } },
    })
      .then((result) => {
        if (my !== reqIdRef.current) return
        setUnits(result.results)
        setUnitsSnapshot(result.results)
        setUnitsLoaded(true)
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
        全局共享的物料主数据:可标记客户物料;编号按「分类号[客户号]-序号」自动取号,不可手填;图纸、其他文件与单位转换建料时即可一并录入。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="invMaterials"
          client={materialClient}
          columns={GRID_COLUMNS}
          joinFields={{ category: ['code'] }}
          overrides={{ categoryId: { render: (_value, row) => <CategoryCell row={row} /> } }}
          attachmentImages={{ ownerType: 'inv_material', category: 'drawing', label: '图纸' }}
          onView={(row) => openDrawer('view', row)}
          onCreate={() => openDrawer('create', null)}
          onEdit={(row) => openDrawer('edit', row)}
          rowActions={statusToggleActions({
            field: 'active',
            update: materialClient.update,
            // 抽屉走 rowId 自查,状态翻转后一并失效行缓存
            onDone: () => queryClient.invalidateQueries({ queryKey: ['rowById', materialClient.id, 'invMaterials'] }),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource="invMaterials"
        client={materialClient}
        {...drawerConfig('invMaterials')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        extraContent={(mode, row) => (
          // 图纸与其他文件两组附件槽位并排,同 hrEmployees 证件照先例
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
        )}
        tabExtraContent={{
          // 单位转换 tab:基准单位提示随默认单位草稿联动;保存语义不变(随主表单 diff 提交)
          units: (mode, row, values) => {
            // 默认单位:编辑/新建态取表单草稿(可能刚改),view 态取行数据;转换行不能选它
            const defaultUnitId = ((values.defaultUnitId ?? row?.defaultUnitId) as string | null) ?? null
            const baseName = defaultUnitId
              ? String(unitNames?.find((u) => u.id === defaultUnitId)?.name ?? '…')
              : '未选择'
            return (
              <SynieEditableTable
                resource="invMaterialUnits"
                client={materialUnitClient}
                label="单位转换"
                title={
                  <span>
                    单位转换
                    <span className="ml-2 text-xs font-normal text-muted">
                      基准单位:{baseName}(1 默认单位 = x 该单位)
                    </span>
                  </span>
                }
                items={units}
                onChange={setUnits}
                readOnly={mode === 'view' || (mode !== 'create' && !unitsLoaded)}
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
            )
          },
        }}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            const created = await materialClient.create(values)
            const materialId = created.id
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
            await materialClient.update(materialId, values)
            const unitErrors = await persistUnits(materialId, units, unitsSnapshot)
            if (unitErrors.length > 0) {
              toast.danger('物料已更新,但部分单位转换保存失败', { description: unitErrors.join('; ') })
            } else {
              toast.success('物料已更新')
            }
          }
          queryClient.invalidateQueries({ queryKey: ['gridRows', materialClient.id, 'invMaterials'] })
          // 抽屉走 rowId 自查,一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', materialClient.id, 'invMaterials'] })
        }}
      />
    </>
  )
}
