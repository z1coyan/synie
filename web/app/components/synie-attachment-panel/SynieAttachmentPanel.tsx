import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Modal, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { downloadFile, uploadFile } from '~/lib/files'

/**
 * 通用附件面板:挂在 SynieRecordDrawer 的 extraContent,按 owner_type/owner_id
 * 多态引用宿主记录,业务表零改动。上传/删除即时落库,不走抽屉草稿。
 */
export interface SynieAttachmentPanelProps {
  /** 宿主资源标识(graphql type 名,如 sal_customer) */
  ownerType: string
  /** 宿主记录 id;create 模式下还没有,面板显示提示 */
  ownerId?: string | null
  /** 业务槽位,缺省 default;设置后上传/列表都限定该槽位 */
  category?: string
  /** view 模式只读:隐藏上传/删除 */
  readonly?: boolean
}

interface AttachmentRow {
  id: string
  category: string
  insertedAt: string
  file: { id: string; filename: string; contentType: string | null; size: number | null }
}

const DESTROY_ATTACHMENT = `
  mutation ($id: ID!) {
    destroySysAttachment(id: $id) { result { id } errors { message } }
  }
`
const DESTROY_FILE = `
  mutation ($id: ID!) {
    destroySysFile(id: $id) { result { id } errors { message } }
  }
`

function formatBytes(size: number | null): string {
  if (size == null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function SynieAttachmentPanel({ ownerType, ownerId, category, readonly }: SynieAttachmentPanelProps) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AttachmentRow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // 无共享权限 hook,面板自查;queryKey 共享,多实例只发一次。fail-closed:拉不到=无权限
  const perms = useQuery({
    queryKey: ['myPermissions'],
    queryFn: () =>
      gqlFetch<{ myPermissions: string[] }>('query { myPermissions }').then((d) => new Set(d.myPermissions)),
  })
  const canCreate = (perms.data?.has('sys.file:create') ?? false) && !readonly
  const canDelete = (perms.data?.has('sys.file:delete') ?? false) && !readonly

  const listKey = ['sysAttachments', ownerType, ownerId ?? '', category ?? '']

  const list = useQuery({
    queryKey: listKey,
    enabled: !!ownerId,
    queryFn: () => {
      // owner_type/category 是开发期常量,ownerId 是库里 uuid,内插安全(与 DataGrid 同做法)
      const categoryFilter = category ? `, category: { eq: "${category}" }` : ''
      const query = `query {
        sysAttachments(limit: 200, filter: { ownerType: { eq: "${ownerType}" }, ownerId: { eq: "${ownerId}" }${categoryFilter} }) {
          results { id category insertedAt file { id filename contentType size } }
        }
      }`
      return gqlFetch<{ sysAttachments: { results: AttachmentRow[] } }>(query).then((d) =>
        [...d.sysAttachments.results].sort((a, b) => a.insertedAt.localeCompare(b.insertedAt))
      )
    },
  })

  const handlePick = () => fileInputRef.current?.click()

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || !ownerId) return
    setUploading(true)
    const toastId = toast('正在上传…', { isLoading: true, timeout: 0 })
    try {
      for (const file of Array.from(files)) {
        await uploadFile(file, { ownerType, ownerId, category })
      }
      toast.success(`已上传 ${files.length} 个附件`)
      await queryClient.invalidateQueries({ queryKey: listKey })
    } catch (e) {
      toast.danger('上传失败', { description: (e as Error).message })
    } finally {
      toast.close(toastId)
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDownload = async (row: AttachmentRow) => {
    try {
      await downloadFile(row.file.id, row.file.filename)
    } catch (e) {
      toast.danger('下载失败', { description: (e as Error).message })
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await gqlFetch<{ destroySysAttachment: { errors: { message: string }[] | null } }>(
        DESTROY_ATTACHMENT,
        { id: deleteTarget.id }
      )
      if (res.destroySysAttachment.errors?.length) {
        throw new Error(res.destroySysAttachment.errors.map((e) => e.message).join('; '))
      }
      // 文件行与物理对象一并清理;若文件仍被他处引用会被 FK 挡住,忽略即可
      await gqlFetch(DESTROY_FILE, { id: deleteTarget.file.id }).catch(() => undefined)
      toast.success('附件已删除')
      setDeleteTarget(null)
      await queryClient.invalidateQueries({ queryKey: listKey })
    } catch (e) {
      toast.danger('删除失败', { description: (e as Error).message })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">附件</span>
        {canCreate && ownerId && (
          <>
            {/* 文件选择必须走原生 input,隐藏后由 Button 代理触发 */}
            <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => handleUpload(e.target.files)} />
            <Button size="sm" variant="secondary" isPending={uploading} onPress={handlePick}>
              <UploadIcon />
              上传附件
            </Button>
          </>
        )}
      </div>

      {!ownerId ? (
        <p className="text-sm text-muted">保存后即可上传附件</p>
      ) : list.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size="sm" />
        </div>
      ) : list.isError ? (
        <p className="text-sm text-danger">附件加载失败:{(list.error as Error).message}</p>
      ) : list.data!.length === 0 ? (
        <p className="text-sm text-muted">暂无附件</p>
      ) : (
        <ul className="divide-y divide-separator rounded-2xl border border-border">
          {list.data!.map((row) => (
            <li key={row.id} className="flex items-center gap-3 px-3 py-2">
              <FileIcon />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={row.file.filename}>
                  {row.file.filename}
                </p>
                <p className="text-xs text-muted">
                  {formatBytes(row.file.size)}
                  {row.insertedAt ? ` · ${row.insertedAt.slice(0, 10)}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" isIconOnly aria-label="下载" onPress={() => handleDownload(row)}>
                <DownloadIcon />
              </Button>
              {canDelete && (
                <Button
                  size="sm"
                  variant="danger-soft"
                  isIconOnly
                  aria-label="删除"
                  onPress={() => setDeleteTarget(row)}
                >
                  <TrashIcon />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal.Backdrop isOpen={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>删除附件</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm">
                确定删除附件「{deleteTarget?.file.filename}」?文件将一并从存储中清除,不可恢复。
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button variant="danger" isPending={deleting} onPress={handleDelete}>
                确认删除
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  )
}

// 项目无图标库,与 SynieDataGrid 同款手写内联 SVG
function UploadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M8 11V3.5M4.5 7L8 3.5 11.5 7M3 13.5h10" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M8 3.5V11M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9M6.5 7v4M9.5 7v4" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <path d="M4 2h5l3 3v9H4zM9 2v3h3" />
    </svg>
  )
}
