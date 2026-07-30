import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Input, Label, TextField, toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { storageClient } from '~/lib/resources/files'
import { resourceBindingFor } from '~/lib/resources/registry'

export const Route = createFileRoute('/_app/system/storages')({
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
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [secret, setSecret] = useState('')
  const queryClient = useQueryClient()
  const binding = resourceBindingFor('sysStorages')
  const invalidateGrid = () =>
    queryClient.invalidateQueries({ queryKey: ['gridRows', storageClient.id, 'sysStorages'] })

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">存储接入</h1>
      <p className="mt-2 text-sm text-ink-500">
        文件存储接入点:内置 local 不可删除;新上传写入默认接入点,已有文件各自留在原接入点。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysStorages"
          client={storageClient}
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
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
                  await binding.commands.execute('setDefault', { id: String(row.id) })
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
        {...drawerConfig('sysStorages')}
        resource="sysStorages"
        client={storageClient}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDrawer(null)
            setSecret('')
          }
        }}
        row={drawer?.row}
        fields={{
          name: { order: 1, cols: 6, required: true, edit: 'createOnly', placeholder: '如 oss-hz,建后不可改' },
          label: { order: 2, cols: 6, required: true, placeholder: '如 杭州 OSS' },
          kind: {
            order: 3,
            cols: 6,
            required: true,
            edit: 'createOnly',
            effects: () => ({
              root: null,
              endpoint: null,
              region: null,
              bucket: null,
              prefix: null,
              accessKeyId: null,
            }),
          },
          isDefault: { order: 4, cols: 6, edit: 'readOnly' },
          secretConfigured: { visible: () => false },
          builtin: { visible: () => false },
          root: {
            order: 5,
            required: true,
            visible: (values) => values.kind === 'LOCAL',
            placeholder: '如 uploads(相对后端工作目录)或 /var/synie/uploads',
          },
          endpoint: {
            order: 6,
            required: true,
            visible: isObjectStore,
            placeholder: '如 https://oss-cn-hangzhou.aliyuncs.com 或 http://127.0.0.1:9000',
          },
          region: { order: 7, cols: 6, visible: isObjectStore, placeholder: '如 cn-hangzhou,可留空' },
          bucket: { order: 8, cols: 6, required: true, visible: isObjectStore },
          prefix: { order: 9, visible: isObjectStore, placeholder: '对象键前缀(默认路径),可留空' },
          accessKeyId: { order: 10, cols: 6, required: true, visible: isObjectStore },
        }}
        onEdit={() => setDrawer((value) => (value ? { ...value, mode: 'edit' } : value))}
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
            await storageClient.create({
              ...common,
              name: String(values.name ?? ''),
              kind: String(values.kind ?? ''),
            })
          } else {
            await storageClient.update(drawer!.row!.id, common)
          }
          toast.success(mode === 'create' ? '存储接入已创建' : '存储接入已更新')
          await invalidateGrid()
        }}
      />
    </>
  )
}
