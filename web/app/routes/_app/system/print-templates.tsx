import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Label, ListBox, Select, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { uploadFile } from '~/lib/files'
import { fetchFieldCatalog, type FieldCatalog } from '~/lib/print'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/print-templates')({
  component: PrintTemplatesPage,
})

const CREATE = `
  mutation ($input: CreateSysPrintTemplateInput!) {
    createSysPrintTemplate(input: $input) { result { id } errors { message } }
  }
`
const UPDATE = `
  mutation ($id: ID!, $input: UpdateSysPrintTemplateInput!) {
    updateSysPrintTemplate(id: $id, input: $input) { result { id } errors { message } }
  }
`
const SET_DEFAULT = `
  mutation ($id: ID!) {
    setDefaultSysPrintTemplate(id: $id) { result { id } errors { message } }
  }
`
const PERMISSION_CATALOG = `
  query { permissionCatalog { prefix label } }
`

interface ResourceOption {
  prefix: string
  label: string
}

// 权限目录按「域.资源」组织;下拉按域中文名分域展示
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

function resourceOptionText(r: ResourceOption) {
  const domain = r.prefix.split('.')[0]
  return `${DOMAIN_LABELS[domain] ?? domain} · ${r.label}`
}

const GRID_COLUMNS = ['name', 'resource', 'isDefault', 'remarks', 'updatedAt']

function PrintTemplatesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [fileId, setFileId] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [catalog, setCatalog] = useState<FieldCatalog | null>(null)
  const [resourcePick, setResourcePick] = useState('sales.order')
  const [resources, setResources] = useState<ResourceOption[]>([])
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    void gqlFetch<{ permissionCatalog: ResourceOption[] }>(PERMISSION_CATALOG)
      .then((data) => setResources(data.permissionCatalog))
      .catch((e: unknown) => {
        setResources([])
        toast.danger(e instanceof Error ? e.message : '加载资源目录失败')
      })
  }, [])

  useEffect(() => {
    if (resources.length > 0 && !resources.some((r) => r.prefix === resourcePick)) {
      setResourcePick(resources[0].prefix)
    }
  }, [resources, resourcePick])

  useEffect(() => {
    if (!drawer) return
    const res =
      drawer.mode === 'create'
        ? resourcePick
        : String(drawer.row?.resource ?? resourcePick)
    void fetchFieldCatalog(res)
      .then(setCatalog)
      .catch(() => setCatalog(null))
  }, [drawer, resourcePick])

  const onPickFile = async (file: File | null) => {
    if (!file) return
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
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '上传失败')
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
          resource="sysPrintTemplates"
          columns={GRID_COLUMNS}
          overrides={{
            resource: {
              label: '资源',
              render: (v) => resources.find((r) => r.prefix === v)?.label ?? String(v ?? ''),
            },
          }}
          onView={(row) => {
            setFileId(null)
            setFileName('')
            setDrawer({ mode: 'view', row })
          }}
          onCreate={() => {
            setFileId(null)
            setFileName('')
            setResourcePick(resources[0]?.prefix ?? 'sales.order')
            setDrawer({ mode: 'create', row: null })
          }}
          onEdit={(row) => {
            setFileId(null)
            setFileName('')
            setDrawer({ mode: 'edit', row })
          }}
          rowActions={[
            {
              key: 'setDefault',
              label: '设为默认',
              capability: 'update',
              onAction: async (row, ctx) => {
                if (row.isDefault) {
                  toast.warning('已是默认模板')
                  return
                }
                try {
                  const data = await gqlFetch<{
                    setDefaultSysPrintTemplate: { errors: { message: string }[] | null }
                  }>(SET_DEFAULT, { id: row.id })
                  const errors = data.setDefaultSysPrintTemplate.errors
                  if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '))
                  toast.success(`已将「${String(row.name)}」设为默认`)
                  ctx.refetch()
                } catch (e) {
                  toast.danger(e instanceof Error ? e.message : '设为默认失败')
                }
              },
            },
          ]}
        />
      </div>

      <SynieRecordDrawer
        {...drawerConfig('sysPrintTemplates')}
        resource="sysPrintTemplates"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDrawer(null)
            setFileId(null)
            setFileName('')
          }
        }}
        rowId={drawer?.row?.id}
        fields={{
          name: { order: 1, cols: 6, required: true },
          // 创建用 extraContent 选择器提交；详情只读展示 resource 列自 meta
          resource: {
            order: 2,
            cols: 6,
            edit: 'readOnly',
            visible: (values) => values.resource != null && values.resource !== '',
          },
          isDefault: { order: 3, cols: 6, edit: 'readOnly' },
          fileId: { visible: () => false },
          remarks: { order: 10, cols: 12 },
        }}
        extraContent={(mode) => (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            {mode === 'create' && (
              <div className="flex flex-col gap-1">
                <Label>资源类型</Label>
                <Select
                  selectedKey={resourcePick}
                  onSelectionChange={(k) => setResourcePick(String(k))}
                  aria-label="资源类型"
                >
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {resources.map((r) => (
                        <ListBox.Item key={r.prefix} id={r.prefix} textValue={resourceOptionText(r)}>
                          {resourceOptionText(r)}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            )}

            {mode !== 'view' && (
              <div className="flex flex-col gap-2">
                <Label>模板文件（.xlsx）</Label>
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  disabled={uploading}
                  onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
                />
                {fileName && <p className="text-sm text-muted">已选：{fileName}</p>}
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
                  {catalog.fields.map((f) => (
                    <li key={f.name}>{`\${${f.name}}`}</li>
                  ))}
                </ul>
                {catalog.loops.map((loop) => (
                  <div key={loop.name}>
                    <p className="mb-1 text-muted">循环区（{loop.name}.* 写在同一行）</p>
                    <ul className="mb-2 list-inside list-disc font-mono text-xs">
                      <li>{`\${${loop.name}._seq}`} — 行序号</li>
                      {loop.fields.map((f) => (
                        <li key={`${loop.name}.${f.name}`}>{`\${${loop.name}.${f.name}}`}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        onSubmit={async (values) => {
          if (drawer?.mode === 'create') {
            if (!fileId) throw new Error('请上传模板文件')
            const data = await gqlFetch<{
              createSysPrintTemplate: { errors: { message: string }[] | null }
            }>(CREATE, {
              input: {
                name: values.name,
                resource: resourcePick,
                fileId,
                remarks: values.remarks ?? null,
              },
            })
            const errors = data.createSysPrintTemplate.errors
            if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '))
            return
          }
          if (drawer?.mode === 'edit' && drawer.row) {
            const input: Record<string, unknown> = {
              name: values.name,
              remarks: values.remarks ?? null,
            }
            if (fileId) input.fileId = fileId
            const data = await gqlFetch<{
              updateSysPrintTemplate: { errors: { message: string }[] | null }
            }>(UPDATE, { id: drawer.row.id, input })
            const errors = data.updateSysPrintTemplate.errors
            if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '))
          }
        }}
      />
    </>
  )
}
