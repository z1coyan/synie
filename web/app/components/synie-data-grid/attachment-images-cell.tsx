import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { attachmentListKey, fetchAttachmentList } from '../synie-attachment-panel/attachments'
import { FileThumb } from '../synie-preview/FileThumb'
import type { SyniePreviewItem } from '../synie-preview/SyniePreview'

/** 附件图片列单元格:行自查图片附件(与附件面板同 queryKey,30s 内重挂不重取),
 *  首图缩略图 + 超出计数,点击预览该行全部图片;表格附件列与卡片首图共用 */
export function AttachmentImagesCell({
  ownerType,
  ownerId,
  category,
  onPreview,
  placeholder = <span className="text-muted">—</span>,
}: {
  ownerType: string
  ownerId: string
  category?: string
  onPreview: (items: SyniePreviewItem[]) => void
  /** 无图占位;卡片首图位传 null(不占位),表格列默认 — */
  placeholder?: ReactNode
}) {
  const list = useQuery({
    queryKey: attachmentListKey(ownerType, ownerId, category),
    staleTime: 30_000,
    queryFn: () => fetchAttachmentList(ownerType, ownerId, category),
  })
  const images = (list.data ?? []).filter((r) => r.file.contentType?.startsWith('image/'))
  if (images.length === 0) return <>{placeholder}</>
  return (
    <span className="flex items-center gap-1.5">
      <FileThumb
        fileId={images[0].file.id}
        alt={images[0].file.filename}
        onPress={() => onPreview(images.map((r) => ({ fileId: r.file.id, filename: r.file.filename })))}
      />
      {images.length > 1 && <span className="text-xs text-muted">+{images.length - 1}</span>}
    </span>
  )
}
