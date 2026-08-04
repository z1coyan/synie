/**
 * 模具管理：模具设计档案独立页(不再复用物料页)。
 * 创建/编辑字段(name/spec/moldType/unitId)都不是资源字段,抽屉手写(同 Sheet 先例),
 * 不走 SynieRecordDrawer 资源表单;删除走网格行内建删除(canDelete + 确认弹窗)。
 * 附件挂物料(ownerType=inv_material, ownerId=materialId):编辑/查看态直连,
 * 创建态 pending 暂存,保存成功后按槽位 attachFile 挂接(同 MaterialsPage 先例)。
 */
import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Input, Label, ListBox, Select, TextField, toast } from '@heroui/react'
import { Sheet } from '@heroui-pro/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { QueryState } from '~/components/synie-query-state/QueryState'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { attachFile, type UploadedFile } from '~/lib/files'
import { moldDesignClient } from '~/lib/resources/manufacturing'
import { resourceBindingFor } from '~/lib/resources/registry'
import { toastError } from '~/lib/toast'

export const Route = createFileRoute('/_app/mfg/molds')({
  component: MoldsPage,
})

const RESOURCE = 'mfgMoldDesigns'
const GRID_COLUMNS = [
  'materialCode',
  'materialName',
  'materialSpec',
  'moldType',
  'unitName',
  'insertedAt',
]

const MOLD_TYPES = [
  { value: 'STAMPING', label: '冲压' },
  { value: 'FORMING', label: '变形' },
  { value: 'POSITIONING', label: '定位' },
  { value: 'OTHER', label: '其他' },
] as const

function moldTypeLabel(value: unknown): string {
  return MOLD_TYPES.find((t) => t.value === value)?.label ?? String(value ?? '—')
}

interface MoldDraft {
  name: string
  spec: string
  moldType: string | null
  unitId: string | null
}

const EMPTY_DRAFT: MoldDraft = { name: '', spec: '', moldType: null, unitId: null }

function MoldsPage() {
  const { drawer, row, rowPending, rowMissing, rowError, open, setMode, close } =
    useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<MoldDraft>(EMPTY_DRAFT)
  // 抽屉身份(create/edit/view × recordId)变化才重建草稿;view/edit 态等行加载完再回填
  const [draftKey, setDraftKey] = useState<string | null>(null)
  // 创建态暂存附件(图纸/其他两槽位):先传裸文件,建档成功后统一挂接;抽屉重开即清空
  const [pendingDrawings, setPendingDrawings] = useState<UploadedFile[]>([])
  const [pendingOthers, setPendingOthers] = useState<UploadedFile[]>([])
  const [saving, setSaving] = useState(false)

  const drawerKey = drawer ? `${drawer.mode}:${drawer.recordId ?? 'new'}` : null

  useEffect(() => {
    if (!drawer || !drawerKey) {
      setDraft(EMPTY_DRAFT)
      setDraftKey(null)
      setPendingDrawings([])
      setPendingOthers([])
      return
    }
    if (draftKey === drawerKey) return
    // view/edit 深链:行未加载完成前不初始化,防空草稿覆盖
    if (drawer.mode !== 'create' && !row) return
    setDraft(
      drawer.mode === 'create'
        ? EMPTY_DRAFT
        : {
            name: String(row?.materialName ?? ''),
            spec: String(row?.materialSpec ?? ''),
            moldType: row?.moldType ? String(row.moldType) : null,
            unitId: row?.unitId ? String(row.unitId) : null,
          },
    )
    setPendingDrawings([])
    setPendingOthers([])
    setDraftKey(drawerKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅抽屉身份与行就绪变化时重建草稿
  }, [drawerKey, row])

  const mode = drawer?.mode ?? 'view'
  const materialId = row?.materialId ? String(row.materialId) : undefined

  const save = async () => {
    if (!drawer) return
    const name = draft.name.trim()
    const spec = draft.spec.trim()
    if (!name) {
      toast.danger('请填写模具名称')
      return
    }
    if (!draft.moldType) {
      toast.danger('请选择模具类型')
      return
    }
    if (!draft.unitId) {
      toast.danger('请选择单位')
      return
    }
    setSaving(true)
    try {
      if (drawer.mode === 'create') {
        const created = await moldDesignClient.create({
          name,
          ...(spec ? { spec } : {}),
          moldType: draft.moldType,
          unitId: draft.unitId,
        })
        // 暂存附件按槽位统一挂接到新建物料;个别失败不阻断建档,提示手工补传
        const newMaterialId = String(created.materialId)
        const failed: string[] = []
        for (const { file, category } of [
          ...pendingDrawings.map((file) => ({ file, category: 'drawing' })),
          ...pendingOthers.map((file) => ({ file, category: 'default' })),
        ]) {
          try {
            await attachFile(file.id, {
              ownerType: 'inv_material',
              ownerId: newMaterialId,
              category,
            })
          } catch {
            failed.push(file.filename)
          }
        }
        if (failed.length > 0) {
          toast.warning(`模具已创建,但附件挂接失败:${failed.join('、')},请在详情附件区手工补传`)
        } else {
          toast.success('模具已创建')
        }
      } else {
        await moldDesignClient.update(String(drawer.recordId), {
          name,
          // spec 需要置空时传 null(后端口径)
          spec: spec === '' ? null : spec,
          moldType: draft.moldType,
          unitId: draft.unitId,
        })
        toast.success('模具已更新')
      }
      await resourceBindingFor(RESOURCE).cache.invalidateAll(queryClient)
      close()
    } catch (e) {
      // 后端业务错误(如「请先在生产设置中配置模具物料分类」)经 description 原样展示
      toastError(drawer.mode === 'create' ? '创建模具失败' : '更新模具失败')(e)
    } finally {
      setSaving(false)
    }
  }

  const heading =
    mode === 'create' ? '新增模具' : mode === 'edit' ? '编辑模具' : '模具详情'

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">模具管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        模具即模具设计档案:保存时系统自动创建资产类物料(分类取生产设置的模具物料分类),
        编号自动取号;图纸与附件挂在物料上。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          onView={(r) => open('view', String(r.id))}
          onCreate={() => open('create')}
          onEdit={(r) => open('edit', String(r.id))}
        />
      </div>

      <Sheet isOpen={drawer !== null} onOpenChange={(isOpen) => !isOpen && close()} placement="right">
        <Sheet.Backdrop>
          <Sheet.Content className="w-full lg:w-[640px]">
            <Sheet.Dialog className="h-full">
              <Sheet.CloseTrigger />
              <Sheet.Header>
                <Sheet.Heading>{heading}</Sheet.Heading>
              </Sheet.Header>
              <Sheet.Body>
                {mode !== 'create' && (rowPending || rowError || rowMissing) ? (
                  rowMissing && !rowPending && !rowError ? (
                    <p className="py-8 text-center text-sm text-muted">记录不存在或已删除</p>
                  ) : (
                    <QueryState isPending={rowPending} error={rowError} />
                  )
                ) : mode === 'view' ? (
                  <div className="flex flex-col gap-6">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                      <div>
                        <dt className="text-muted">模具编号</dt>
                        <dd>{String(row?.materialCode ?? '—')}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">模具名称</dt>
                        <dd>{String(row?.materialName ?? '—')}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">模具规格</dt>
                        <dd>{row?.materialSpec ? String(row.materialSpec) : '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">模具类型</dt>
                        <dd>{moldTypeLabel(row?.moldType)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">单位</dt>
                        <dd>{String(row?.unitName ?? '—')}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">创建时间</dt>
                        <dd>{row?.insertedAt ? String(row.insertedAt).slice(0, 19).replace('T', ' ') : '—'}</dd>
                      </div>
                    </dl>
                    <div className="grid grid-cols-1 gap-6">
                      <SynieAttachmentPanel
                        ownerType="inv_material"
                        ownerId={materialId}
                        category="drawing"
                        label="图纸"
                        accept="image/*"
                        readonly
                      />
                      <SynieAttachmentPanel
                        ownerType="inv_material"
                        ownerId={materialId}
                        category="default"
                        label="其他文件"
                        readonly
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-6">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <TextField value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} isRequired>
                        <Label>模具名称</Label>
                        <Input />
                      </TextField>
                      <TextField value={draft.spec} onChange={(v) => setDraft((d) => ({ ...d, spec: v }))}>
                        <Label>模具规格</Label>
                        <Input placeholder="如 冲孔模 Φ12" />
                      </TextField>
                      <Select
                        value={draft.moldType}
                        onChange={(v) => setDraft((d) => ({ ...d, moldType: v == null ? null : String(v) }))}
                        isRequired
                      >
                        <Label>模具类型</Label>
                        <Select.Trigger>
                          <Select.Value>
                            {({ isPlaceholder, defaultChildren }) =>
                              isPlaceholder ? '选择类型…' : defaultChildren
                            }
                          </Select.Value>
                          <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                          <ListBox>
                            {MOLD_TYPES.map((t) => (
                              <ListBox.Item key={t.value} id={t.value} textValue={t.label}>
                                {t.label}
                                <ListBox.ItemIndicator />
                              </ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                      <RemoteSelect
                        resource="basUnits"
                        label="单位"
                        placeholder="选择单位…"
                        value={draft.unitId}
                        onChange={(id) => setDraft((d) => ({ ...d, unitId: id }))}
                        isRequired
                        searchFields={['name']}
                      />
                    </div>
                    {/* 图纸与其他文件两槽位;create 态走暂存,保存成功后按槽位统一挂接 */}
                    <div className="grid grid-cols-1 gap-6">
                      <SynieAttachmentPanel
                        ownerType="inv_material"
                        ownerId={materialId}
                        category="drawing"
                        label="图纸"
                        accept="image/*"
                        pending={
                          mode === 'create'
                            ? {
                                files: pendingDrawings,
                                onAdd: (f) => setPendingDrawings((fs) => [...fs, f]),
                                onRemove: (id) =>
                                  setPendingDrawings((fs) => fs.filter((f) => f.id !== id)),
                              }
                            : undefined
                        }
                      />
                      <SynieAttachmentPanel
                        ownerType="inv_material"
                        ownerId={materialId}
                        category="default"
                        label="其他文件"
                        pending={
                          mode === 'create'
                            ? {
                                files: pendingOthers,
                                onAdd: (f) => setPendingOthers((fs) => [...fs, f]),
                                onRemove: (id) =>
                                  setPendingOthers((fs) => fs.filter((f) => f.id !== id)),
                              }
                            : undefined
                        }
                      />
                    </div>
                  </div>
                )}
              </Sheet.Body>
              <Sheet.Footer>
                {mode === 'view' ? (
                  <>
                    <Button variant="secondary" onPress={close}>
                      关闭
                    </Button>
                    <Button onPress={() => setMode('edit')}>编辑</Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" isDisabled={saving} onPress={close}>
                      取消
                    </Button>
                    <Button
                      onPress={() => void save()}
                      isPending={saving}
                      isDisabled={mode === 'edit' && (rowPending || !row)}
                    >
                      保存
                    </Button>
                  </>
                )}
              </Sheet.Footer>
            </Sheet.Dialog>
          </Sheet.Content>
        </Sheet.Backdrop>
      </Sheet>
    </>
  )
}
