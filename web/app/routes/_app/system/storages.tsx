import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Input, Label, TextField, toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import {
  useCatalogBasicForm,
  requireWriter,
} from '~/lib/resources/catalog'
import { executeSingleRowCommandWithInvalidation } from '~/lib/resources/command-invalidation'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

const RESOURCE = 'sysStorages'

export const Route = createFileRoute('/_app/system/storages')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: StoragesPage,
})

const GRID_COLUMNS = ['label', 'name', 'kind', 'isDefault', 'insertedAt']
const isObjectStore = (values: Record<string, unknown>) =>
  values.kind === 'S3' || values.kind === 'OSS'

function optionalString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? null : text
}

function StoragesPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const [secret, setSecret] = useState('')
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '存储接入')
  const invalidateGrid = () => binding.cache.invalidateGrid(queryClient)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">存储接入</h1>
      <p className="mt-2 text-sm text-ink-500">
        文件存储接入点:内置 local 不可删除;新上传写入默认接入点,已有文件各自留在原接入点。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
          rowActions={[
            {
              key: 'setDefault',
              label: '设为默认',
              // requiredCapability=update（与 command 文档一致，非 action key）
              capability: 'update',
              onAction: async (row, context) => {
                if (row.isDefault) {
                  toast.warning('该接入点已是默认存储')
                  return
                }
                try {
                  if (!binding.commands) throw new Error('存储接入未绑定 setDefault 命令')
                  await executeSingleRowCommandWithInvalidation(
                    binding.resource,
                    'setDefault',
                    String(row.id),
                    queryClient,
                  )
                  toast.success(`已将「${String(row.label)}」设为默认存储`)
                  await context.refetch()
                } catch (error) {
                  toast.danger(error instanceof Error ? error.message : '设为默认失败')
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
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            close()
            setSecret('')
          }
        }}
        rowId={drawer?.recordId ?? undefined}
        exclude={formProps.exclude}
        fields={{
          ...formProps.fields,
          kind: {
            ...formProps.fields.kind,
            effects: () => ({
              root: null,
              endpoint: null,
              region: null,
              bucket: null,
              prefix: null,
              accessKeyId: null,
            }),
          },
          root: {
            ...formProps.fields.root,
            required: true,
            visible: (values) => values.kind === 'LOCAL',
          },
          endpoint: {
            ...formProps.fields.endpoint,
            required: true,
            visible: isObjectStore,
          },
          region: { ...formProps.fields.region, visible: isObjectStore },
          bucket: {
            ...formProps.fields.bucket,
            required: true,
            visible: isObjectStore,
          },
          prefix: { ...formProps.fields.prefix, visible: isObjectStore },
          accessKeyId: {
            ...formProps.fields.accessKeyId,
            required: true,
            visible: isObjectStore,
          },
        }}
        onEdit={() => setMode('edit')}
        extraContent={(mode, _row, values) =>
          mode !== 'view' && isObjectStore(values) ? (
            <TextField value={secret} onChange={setSecret} isRequired={mode === 'create'}>
              <Label>Secret Access Key</Label>
              <Input
                type="password"
                placeholder={mode === 'create' ? '对象存储密钥,只写不回读' : '已配置,留空不修改'}
              />
            </TextField>
          ) : null
        }
        onSubmit={async (values, mode) => {
          const common = {
            label: String(values.label ?? ''),
            root: optionalString(values.root),
            endpoint: optionalString(values.endpoint),
            region: optionalString(values.region),
            bucket: optionalString(values.bucket),
            prefix: optionalString(values.prefix),
            accessKeyId: optionalString(values.accessKeyId),
            ...(secret.trim() === '' ? {} : { secretAccessKey: secret }),
          }
          if (mode === 'create') {
            await requireWriter(binding, 'create')({
              ...common,
              name: String(values.name ?? ''),
              kind: String(values.kind ?? ''),
            })
          } else {
            await requireWriter(binding, 'update')(String(drawer!.recordId), common)
          }
          toast.success(mode === 'create' ? '存储接入已创建' : '存储接入已更新')
          setSecret('')
          await invalidateGrid()
        }}
      />
    </>
  )
}
