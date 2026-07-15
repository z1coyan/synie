import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Modal, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { fetchFileBlob, uploadFile } from '~/lib/files'

/**
 * 单图附件槽位:SynieAttachmentPanel 的图片变体,一个 owner+category 槽位一张图
 * (如员工的身份证正/背面)。上传即落库并顶替旧图,点击图片放大预览。
 * 挂 SynieRecordDrawer 的 extraContent,create 态(无宿主 id)显示保存后可上传。
 */
export interface SynieImageAttachmentProps {
  /** 宿主资源标识(graphql type 名,如 hr_employee) */
  ownerType: string
  /** 宿主记录 id;create 模式下还没有,槽位显示提示 */
  ownerId?: string | null
  /** 业务槽位,如 id_front / id_back;同槽位仅保留最新一张 */
  category: string
  /** 槽位标题,如「身份证正面」 */
  label: string
  /** view 模式只读:隐藏上传/删除 */
  readonly?: boolean
}

interface AttachmentRow {
  id: string
  insertedAt: string
  file: { id: string; filename: string; contentType: string | null }
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

// Blob → objectURL 一对一缓存,不主动 revoke:卸载即 revoke 会与抽屉退场动画期间
// 仍引用该 URL 的 <img> 竞态(console 刷 ERR_FILE_NOT_FOUND);URL 随 Blob 被 GC 一起释放,
// 单图槽位量级的驻留可接受,重挂复用同一 URL 也免了图片闪烁
const blobUrls = new WeakMap<Blob, string>()

function blobUrl(blob: Blob): string {
  let url = blobUrls.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    blobUrls.set(blob, url)
  }
  return url
}

export function SynieImageAttachment({ ownerType, ownerId, category, label, readonly }: SynieImageAttachmentProps) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  // 与 SynieAttachmentPanel 同一套权限自查,queryKey 共享只发一次
  const perms = useQuery({
    queryKey: ['myPermissions'],
    queryFn: () =>
      gqlFetch<{ myPermissions: string[] }>('query { myPermissions }').then((d) => new Set(d.myPermissions)),
  })
  const canCreate = (perms.data?.has('sys.file:create') ?? false) && !readonly
  const canDelete = (perms.data?.has('sys.file:delete') ?? false) && !readonly

  // listKey 与 SynieAttachmentPanel 同构,同宿主的失效互相可见
  const listKey = ['sysAttachments', ownerType, ownerId ?? '', category]

  const list = useQuery({
    queryKey: listKey,
    enabled: !!ownerId,
    queryFn: () => {
      // owner_type/category 是开发期常量,ownerId 是库里 uuid,内插安全(与面板同做法)
      const query = `query {
        sysAttachments(limit: 20, filter: { ownerType: { eq: "${ownerType}" }, ownerId: { eq: "${ownerId}" }, category: { eq: "${category}" } }) {
          results { id insertedAt file { id filename contentType } }
        }
      }`
      return gqlFetch<{ sysAttachments: { results: AttachmentRow[] } }>(query).then((d) =>
        [...d.sysAttachments.results].sort((a, b) => a.insertedAt.localeCompare(b.insertedAt))
      )
    },
  })
  // 槽位语义:只呈现最新一张;历史残留(替换失败留下的旧图)不展示
  const current = list.data && list.data.length > 0 ? list.data[list.data.length - 1] : null

  const blob = useQuery({
    queryKey: ['fileBlob', current?.file.id ?? ''],
    enabled: !!current,
    staleTime: Number.POSITIVE_INFINITY, // 文件内容不可变,替换是换 id
    queryFn: () => fetchFileBlob(current!.file.id),
  })
  const objectUrl = blob.data ? blobUrl(blob.data) : null

  const destroyAttachment = async (row: AttachmentRow) => {
    const res = await gqlFetch<{ destroySysAttachment: { errors: { message: string }[] | null } }>(
      DESTROY_ATTACHMENT,
      { id: row.id }
    )
    if (res.destroySysAttachment.errors?.length) {
      throw new Error(res.destroySysAttachment.errors.map((e) => e.message).join('; '))
    }
    // 文件行与物理对象一并清理;若文件仍被他处引用会被 FK 挡住,忽略即可
    await gqlFetch(DESTROY_FILE, { id: row.file.id }).catch(() => undefined)
  }

  const handleUpload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file || !ownerId) return
    if (!file.type.startsWith('image/')) {
      toast.danger('仅支持图片文件')
      return
    }
    setUploading(true)
    try {
      const previous = current
      await uploadFile(file, { ownerType, ownerId, category })
      // 槽位单图:新图落库后清掉旧图;清理失败不影响主流程(展示只取最新)
      if (previous) await destroyAttachment(previous).catch(() => undefined)
      toast.success(`${label}已上传`)
      await queryClient.invalidateQueries({ queryKey: listKey })
    } catch (e) {
      toast.danger('上传失败', { description: (e as Error).message })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async () => {
    if (!current) return
    setDeleting(true)
    try {
      await destroyAttachment(current)
      toast.success(`${label}已删除`)
      setConfirmDelete(false)
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
        <span className="text-sm text-muted">{label}</span>
        {canCreate && ownerId && (
          <div className="flex gap-1">
            {/* 文件选择必须走原生 input,隐藏后由 Button 代理触发(与附件面板同款) */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => handleUpload(e.target.files)}
            />
            <Button size="sm" variant="ghost" isPending={uploading} onPress={() => fileInputRef.current?.click()}>
              {current ? '更换' : '上传'}
            </Button>
            {canDelete && current && (
              <Button size="sm" variant="ghost" className="text-danger" onPress={() => setConfirmDelete(true)}>
                删除
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 身份证横版比例的槽位框;object-contain 完整呈现不裁切 */}
      <div className="flex aspect-[8/5] w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-default/30">
        {!ownerId ? (
          <span className="px-4 text-center text-sm text-muted">保存后即可上传</span>
        ) : list.isLoading || (current && blob.isLoading) ? (
          <Spinner size="sm" />
        ) : list.isError ? (
          <span className="px-4 text-center text-sm text-danger">加载失败:{(list.error as Error).message}</span>
        ) : !current ? (
          <span className="text-sm text-muted">未上传</span>
        ) : blob.isError ? (
          <span className="px-4 text-center text-sm text-danger">图片加载失败:{(blob.error as Error).message}</span>
        ) : objectUrl ? (
          <button
            type="button"
            className="h-full w-full cursor-zoom-in"
            aria-label={`放大查看${label}`}
            onClick={() => setZoomed(true)}
          >
            <img src={objectUrl} alt={label} className="h-full w-full object-contain" />
          </button>
        ) : null}
      </div>

      <Modal.Backdrop isOpen={zoomed} onOpenChange={setZoomed}>
        <Modal.Container>
          <Modal.Dialog className="max-w-3xl" aria-label={`${label}大图`}>
            <Modal.Body className="p-2">
              {objectUrl && <img src={objectUrl} alt={label} className="max-h-[80vh] w-full object-contain" />}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={confirmDelete} onOpenChange={setConfirmDelete}>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>删除{label}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm">确定删除{label}?文件将一并从存储中清除,不可恢复。</p>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setConfirmDelete(false)}>
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
