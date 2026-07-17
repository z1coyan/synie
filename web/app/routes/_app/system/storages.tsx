import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Input, Label, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/storages')({
  component: StoragesPage,
})

const CREATE_STORAGE = `
  mutation ($input: CreateSysStorageInput!) {
    createSysStorage(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_STORAGE = `
  mutation ($id: ID!, $input: UpdateSysStorageInput!) {
    updateSysStorage(id: $id, input: $input) { result { id } errors { message } }
  }
`
const SET_DEFAULT_STORAGE = `
  mutation ($id: ID!) {
    setDefaultSysStorage(id: $id) { result { id } errors { message } }
  }
`

// 连接配置(endpoint/密钥等)不进表格,详情看抽屉;白名单同时把密钥挡在跨列搜索外
const GRID_COLUMNS = ['label', 'name', 'kind', 'isDefault', 'insertedAt']

// s3/oss 共用的对象存储字段(值是 GraphQL 枚举大写 token)
const isObjectStore = (v: Record<string, unknown>) => v.kind === 'S3' || v.kind === 'OSS'

function StoragesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  // 密钥只写不回读:meta/GraphQL 均无此字段,输入由页面自持,提交时并入 input;空 = 不修改
  const [secret, setSecret] = useState('')
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">存储接入</h1>
      <p className="mt-2 text-sm text-ink-500">
        文件存储接入点:内置 local 不可删除;新上传写入默认接入点,已有文件各自留在原接入点。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysStorages"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={[
            {
              key: 'setDefault',
              label: '设为默认',
              capability: 'update',
              onAction: async (row, ctx) => {
                if (row.isDefault) {
                  toast.warning('该接入点已是默认存储')
                  return
                }
                try {
                  const data = await gqlFetch<{
                    setDefaultSysStorage: { errors: { message: string }[] | null }
                  }>(SET_DEFAULT_STORAGE, { id: row.id })
                  const errors = data.setDefaultSysStorage.errors
                  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
                  toast.success(`已将「${String(row.label)}」设为默认存储`)
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
        {...drawerConfig('sysStorages')}
        resource="sysStorages"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDrawer(null)
            setSecret('')
          }
        }}
        // 表格列是白名单子集,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        fields={{
          name: { order: 1, cols: 6, required: true, edit: 'createOnly', placeholder: '如 oss-hz,建后不可改' },
          label: { order: 2, cols: 6, required: true, placeholder: '如 杭州 OSS' },
          // 切换类型时清空对侧配置,避免残值随表单提交
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
          builtin: { visible: () => false },
          root: {
            order: 5,
            required: true,
            visible: (v) => v.kind === 'LOCAL',
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
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        // 密钥输入(meta 无此字段):对象存储才需要;create 必填(后端 KindFields 兜底),edit 留空不修改
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
          const input = secret.trim() !== '' ? { ...values, secretAccessKey: secret } : values
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createSysStorage: { errors: { message: string }[] | null } }>(
              CREATE_STORAGE,
              { input }
            )
            errors = data.createSysStorage.errors
          } else {
            const data = await gqlFetch<{ updateSysStorage: { errors: { message: string }[] | null } }>(
              UPDATE_STORAGE,
              { id: drawer!.row!.id, input }
            )
            errors = data.updateSysStorage.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '存储接入已创建' : '存储接入已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'sysStorages'] })
        }}
      />
    </>
  )
}
