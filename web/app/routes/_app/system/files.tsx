import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { downloadFile } from '~/lib/files'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/files')({
  component: FilesPage,
})

const GRID_COLUMNS = ['filename', 'storage', 'key', 'contentType', 'size', 'uploadedById', 'insertedAt']

function formatSize(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

interface AttachmentRow {
  id: string
  ownerType: string
  ownerId: string
  category: string
  insertedAt: string
}

// 挂接记录:该文件被哪些业务记录引用(有挂接时文件不可删,先去业务侧移除)
function FileAttachments({ fileId }: { fileId: string }) {
  const attachments = useQuery({
    queryKey: ['fileAttachments', fileId],
    queryFn: () => {
      // fileId 是库里 uuid,内插安全(与 SynieAttachmentPanel 同做法)
      const query = `query {
        sysAttachments(limit: 200, filter: { fileId: { eq: "${fileId}" } }) {
          count
          results { id ownerType ownerId category insertedAt }
        }
      }`
      return gqlFetch<{ sysAttachments: { count: number; results: AttachmentRow[] } }>(query)
    },
  })

  const rows = attachments.data?.sysAttachments.results ?? []

  return (
    <div>
      <h3 className="text-sm font-medium">业务挂接({attachments.data?.sysAttachments.count ?? 0})</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">无业务挂接,可直接删除。</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm text-ink-500">
          {rows.map((a) => (
            <li key={a.id}>
              {a.ownerType} · {a.category} · {new Date(a.insertedAt).toLocaleString()}
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
          columns={GRID_COLUMNS}
          overrides={{
            size: { render: formatSize, align: 'end' },
            key: { width: 220 },
          }}
          defaultSort={{ column: 'insertedAt', direction: 'descending' }}
          onView={(row) => setDrawer(row)}
        />
      </div>

      <SynieRecordDrawer
        resource="sysFiles"
        label="文件"
        mode="view"
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        rowId={drawer?.id}
        fields={{ size: { render: formatSize } }}
        extraContent={(_mode, row) => (row?.id ? <FileAttachments fileId={String(row.id)} /> : null)}
        footerActions={(_mode, row) =>
          row?.id ? (
            <Button
              variant="secondary"
              onPress={() => {
                downloadFile(String(row.id), String(row.filename ?? 'file')).catch((e) =>
                  toast.danger(e instanceof Error ? e.message : '下载失败')
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
