import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Label, ListBox, Select, toast } from '@heroui/react'
import { DropZone } from '@heroui-pro/react'
import { apiData, api } from '~/lib/api/client'
import { uploadFile, downloadFile } from '~/lib/files'
import { fetchFieldCatalog, type FieldCatalog } from '~/lib/print'
import { fetchPermissionCatalog } from '~/lib/resources/iam'
import { listPrintResources } from '~/lib/resources/printing'
import { useCatalogBasicForm, requireWriter } from '~/lib/resources/catalog'
import { executeSingleRowCommandWithInvalidation } from '~/lib/resources/command-invalidation'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

const RESOURCE = 'sysPrintTemplates'

export const Route = createFileRoute('/_app/system/print-templates')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: PrintTemplatesPage,
})

interface ResourceOption {
  prefix: string
  label: string
}

const DOMAIN_LABELS: Record<string, string> = {
  sales: '销售',
  purchase: '采购',
  inv: '库存',
  acc: '财务',
  hr: '人事',
  base: '基础数据',
  sys: '系统',
  mfg: '生产',
}

function resourceOptionText(resource: ResourceOption) {
  const domain = resource.prefix.split('.')[0]
  return `${DOMAIN_LABELS[domain] ?? domain} · ${resource.label}`
}

const GRID_COLUMNS = ['name', 'resource', 'isDefault', 'remarks', 'updatedAt']

function PrintTemplatesPage() {
  const queryClient = useQueryClient()
  const { drawer, open, setMode, close, row: drawerRow } = useRecordDrawerUrl(RESOURCE)
  const [fileId, setFileId] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [catalog, setCatalog] = useState<FieldCatalog | null>(null)
  const [resourcePick, setResourcePick] = useState('sales.order')
  const [resources, setResources] = useState<ResourceOption[]>([])
  const [currentFile, setCurrentFile] = useState<{ id: string; filename: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '打印模板')

  useEffect(() => {
    void Promise.all([listPrintResources(), fetchPermissionCatalog()])
      .then(([printResources, permissionCatalog]) => {
        const labels = new Map(
          permissionCatalog.groups.map((group) => [group.prefix, group.label]),
        )
        setResources(
          printResources.resources.map((prefix) => ({
            prefix,
            label: labels.get(prefix) ?? prefix,
          })),
        )
      })
      .catch((error: unknown) => {
        setResources([])
        toast.danger(error instanceof Error ? error.message : '加载资源目录失败')
      })
  }, [])

  useEffect(() => {
    if (resources.length > 0 && !resources.some((resource) => resource.prefix === resourcePick)) {
      setResourcePick(resources[0].prefix)
    }
  }, [resources, resourcePick])

  // 抽屉身份变化:清空本次上传草稿;create 重置资源选择
  useEffect(() => {
    if (!drawer) {
      setFileId(null)
      setFileName('')
      setCurrentFile(null)
      setCatalog(null)
      return
    }
    setFileId(null)
    setFileName('')
    if (drawer.mode === 'create') {
      setResourcePick(resources[0]?.prefix ?? 'sales.order')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅抽屉身份变化时重置上传草稿
  }, [drawer?.recordId, drawer?.mode])

  // 深链/打开既有记录:按 fileId 拉模板文件元数据
  useEffect(() => {
    const currentFileId =
      drawer && drawer.mode !== 'create' && typeof drawerRow?.fileId === 'string'
        ? drawerRow.fileId
        : null
    if (!currentFileId) {
      setCurrentFile(null)
      return
    }
    void apiData(api.files[':id'].metadata.$get({ param: { id: currentFileId } }))
      .then((file) => setCurrentFile({ id: file.id, filename: file.filename }))
      .catch((error: unknown) => {
        setCurrentFile(null)
        toast.danger(error instanceof Error ? error.message : '加载模板文件失败')
      })
  }, [drawer, drawerRow?.fileId])

  // 字段清单:create 用 resourcePick,既有记录用行上 resource
  useEffect(() => {
    if (!drawer) return
    const resource =
      drawer.mode === 'create' ? resourcePick : String(drawerRow?.resource ?? resourcePick)
    void fetchFieldCatalog(resource)
      .then(setCatalog)
      .catch(() => setCatalog(null))
  }, [drawer, drawerRow?.resource, resourcePick])

  const onPickFile = async (file: File | null) => {
    if (!file || uploading) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      toast.danger('只接受 .xlsx 文件')
      return
    }
    setUploading(true)
    try {
      const { file: uploaded } = await uploadFile(file)
      setFileId(uploaded.id)
      setFileName(uploaded.filename)
      toast.success('模板文件已上传')
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">打印模板</h1>
      <p className="mt-2 text-sm text-ink-500">
        维护单据版式 Excel 模板（.xlsx + 占位符）。打印转 PDF、导出为填充后的
        xlsx；同资源可多份、一份默认。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={{
            resource: {
              label: '资源',
              render: (value) =>
                resources.find((resource) => resource.prefix === value)?.label ??
                String(value ?? ''),
            },
          }}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          actionVisible={{
            setDefault: (row) => !row.isDefault,
            unsetDefault: (row) => Boolean(row.isDefault),
          }}
          rowActions={[
            {
              key: 'setDefault',
              label: '设为默认',
              capability: 'update',
              onAction: async (row, context) => {
                try {
                  if (!binding.commands) throw new Error('打印模板未绑定 setDefault 命令')
                  await executeSingleRowCommandWithInvalidation(
                    binding.resource,
                    'setDefault',
                    String(row.id),
                    queryClient,
                  )
                  toast.success(`已将「${String(row.name)}」设为默认`)
                  context.refetch()
                } catch (error) {
                  toast.danger(error instanceof Error ? error.message : '设为默认失败')
                }
              },
            },
            {
              key: 'unsetDefault',
              label: '取消默认',
              capability: 'update',
              onAction: async (row, context) => {
                try {
                  if (!binding.commands) throw new Error('打印模板未绑定 unsetDefault 命令')
                  await executeSingleRowCommandWithInvalidation(
                    binding.resource,
                    'unsetDefault',
                    String(row.id),
                    queryClient,
                  )
                  toast.success(`已取消「${String(row.name)}」的默认标记`)
                  context.refetch()
                } catch (error) {
                  toast.danger(error instanceof Error ? error.message : '取消默认失败')
                }
              },
            },
          ]}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        rowId={drawer?.recordId ?? undefined}
        fields={{
          ...formProps.fields,
          resource: {
            ...formProps.fields.resource,
            visible: (values) => values.resource != null && values.resource !== '',
          },
          fileId: { ...formProps.fields.fileId, visible: () => false },
        }}
        exclude={formProps.exclude}
        extraContent={(mode) => (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            {mode === 'create' && (
              <div className="flex flex-col gap-1">
                <Label>资源类型</Label>
                <Select
                  selectedKey={resourcePick}
                  onSelectionChange={(key) => setResourcePick(String(key))}
                  aria-label="资源类型"
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {resources.map((resource) => (
                        <ListBox.Item
                          key={resource.prefix}
                          id={resource.prefix}
                          textValue={resourceOptionText(resource)}
                        >
                          {resourceOptionText(resource)}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            )}

            {(mode !== 'view' || currentFile) && (
              <div className="flex flex-col gap-2">
                <Label>模板文件（.xlsx）</Label>
                <DropZone>
                  {mode !== 'view' && (
                    <>
                      <DropZone.Area
                        onDrop={async (event) => {
                          for (const item of event.items) {
                            if (item.kind === 'file') {
                              void onPickFile(await item.getFile())
                              return
                            }
                          }
                        }}
                      >
                        <DropZone.Icon />
                        <DropZone.Label>拖拽模板文件到此处，或点击选择</DropZone.Label>
                        <DropZone.Description>
                          仅支持 .xlsx；占位符对照下方字段清单书写
                        </DropZone.Description>
                        <DropZone.Trigger>选择文件</DropZone.Trigger>
                      </DropZone.Area>
                      <DropZone.Input
                        accept=".xlsx"
                        onSelect={(list) => list[0] && void onPickFile(list[0])}
                      />
                    </>
                  )}
                  {(fileName || currentFile) && (
                    <DropZone.FileList>
                      {fileName ? (
                        <DropZone.FileItem status={uploading ? 'uploading' : 'complete'}>
                          <DropZone.FileFormatIcon color="green" format="XLSX" />
                          <DropZone.FileInfo>
                            <DropZone.FileName>{fileName}</DropZone.FileName>
                          </DropZone.FileInfo>
                          <DropZone.FileRemoveTrigger
                            aria-label={`移除 ${fileName}`}
                            onPress={() => {
                              setFileId(null)
                              setFileName('')
                            }}
                          />
                        </DropZone.FileItem>
                      ) : currentFile ? (
                        <DropZone.FileItem status="complete">
                          <DropZone.FileFormatIcon color="green" format="XLSX" />
                          <DropZone.FileInfo>
                            <DropZone.FileName>{currentFile.filename}</DropZone.FileName>
                          </DropZone.FileInfo>
                          <Button
                            variant="secondary"
                            onPress={() =>
                              void downloadFile(currentFile.id, currentFile.filename).catch(
                                (error: unknown) =>
                                  toast.danger(
                                    error instanceof Error ? error.message : '下载失败',
                                  ),
                              )
                            }
                          >
                            下载
                          </Button>
                        </DropZone.FileItem>
                      ) : null}
                    </DropZone.FileList>
                  )}
                </DropZone>
                {mode === 'edit' && !fileName && (
                  <p className="text-xs text-muted">不选文件则保留原模板</p>
                )}
              </div>
            )}

            {catalog && (
              <div className="rounded-md bg-surface-secondary p-3 text-sm">
                <p className="mb-2 font-medium">字段清单（占位符写 ${'{name}'}）</p>
                <p className="mb-1 text-muted">头字段</p>
                <ul className="mb-2 list-inside list-disc font-mono text-xs">
                  {catalog.fields.map((field) => (
                    <li key={field.name}>{`\${${field.name}}`}</li>
                  ))}
                </ul>
                {catalog.loops.map((loop) => (
                  <div key={loop.name}>
                    <p className="mb-1 text-muted">循环区（{loop.name}.* 写在同一行）</p>
                    <ul className="mb-2 list-inside list-disc font-mono text-xs">
                      <li>{`\${${loop.name}._seq}`} — 行序号</li>
                      {loop.fields.map((field) => (
                        <li key={`${loop.name}.${field.name}`}>
                          {`\${${loop.name}.${field.name}}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            if (!fileId) throw new Error('请上传模板文件')
            const created = await requireWriter(binding, 'create', '打印模板')({
              name: values.name,
              resource: resourcePick,
              fileId,
              remarks: values.remarks ?? null,
            })
            await binding.cache.invalidateGrid(queryClient)
            return String(created.id)
          }
          if (mode === 'edit' && drawer?.recordId) {
            const input: Record<string, unknown> = {
              name: values.name,
              remarks: values.remarks ?? null,
            }
            if (fileId) input.fileId = fileId
            await requireWriter(binding, 'update', '打印模板')(String(drawer.recordId), input)
            await binding.cache.invalidateGrid(queryClient)
          }
        }}
      />
    </>
  )
}
