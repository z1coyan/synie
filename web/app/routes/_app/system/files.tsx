import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { downloadFile } from '~/lib/files'
import { fileClient, queryAttachments } from '~/lib/resources/files'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/files')({
  component: FilesPage,
})

const GRID_COLUMNS = ['filename', 'storage', 'key', 'contentType', 'size', 'uploadedById', 'insertedAt']

function formatSize(value: unknown): string {
  const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function FileAttachments({ fileId }: { fileId: string }) {
  const attachments = useQuery({
    queryKey: ['fileAttachments', fileId],
    queryFn: () => queryAttachments({ limit: 200, offset: 0, fileId }),
  })
  const rows = attachments.data?.results ?? []

  return (
    <div>
      <h3 className="text-sm font-medium">业务挂接({attachments.data?.count ?? 0})</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">无业务挂接,可直接删除。</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm text-ink-500">
          {rows.map((attachment) => (
            <li key={attachment.id}>
              {attachment.ownerType} · {attachment.category} ·{' '}
              {new Date(attachment.insertedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function FilesPage() {
  const [drawer, setDrawer] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">文件管理</h1>
      <p className="mt-2 text-sm text-ink-500">
        系统内所有文件对象:存储接入点、对象键与业务挂接;仍有业务挂接的文件需先在业务单据中移除附件才能删除。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="sysFiles"
          client={fileClient}
          columns={GRID_COLUMNS}
          overrides={{
            filename: {
              image: {
                fileId: (row) => (String(row.contentType ?? '').startsWith('image/') ? row.id : null),
                keepText: true,
              },
            },
            size: { render: formatSize, align: 'end' },
            key: { width: 220 },
          }}
          defaultSort={{ column: 'insertedAt', direction: 'descending' }}
          onView={setDrawer}
        />
      </div>

      <SynieRecordDrawer
        resource="sysFiles"
        client={fileClient}
        label="文件"
        mode="view"
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer}
        fields={{ size: { render: formatSize } }}
        extraContent={(_mode, row) => (row?.id ? <FileAttachments fileId={String(row.id)} /> : null)}
        footerActions={(_mode, row) =>
          row?.id ? (
            <Button
              variant="secondary"
              onPress={() => {
                downloadFile(String(row.id), String(row.filename ?? 'file')).catch((error) =>
                  toast.danger(error instanceof Error ? error.message : '下载失败')
                )
              }}
            >
              下载
            </Button>
          ) : null
        }
      />
    </>
  )
}
