import { useQuery } from '@tanstack/react-query'
import { blobUrl, fetchFileBlob } from '~/lib/files'

/**
 * 图片文件缩略图:按 fileId 经鉴权拉字节(['fileBlob'] 缓存与 SyniePreview 互通),
 * 点击交由调用方打开 SyniePreview。附件面板与 DataGrid 图片列共用。
 */
export function FileThumb({
  fileId,
  alt,
  onPress,
  className,
}: {
  fileId: string
  /** 无障碍标签,如文件名 */
  alt?: string
  onPress: () => void
  /** 尺寸覆盖,默认 h-9 w-9 */
  className?: string
}) {
  const blob = useQuery({
    queryKey: ['fileBlob', fileId],
    staleTime: Number.POSITIVE_INFINITY, // 文件内容不可变,替换是换 id
    queryFn: () => fetchFileBlob(fileId),
  })
  const src = blob.data ? blobUrl(blob.data) : null

  return (
    <button
      type="button"
      aria-label={alt ? `预览 ${alt}` : '预览图片'}
      title={blob.isError ? `图片加载失败:${(blob.error as Error).message}` : undefined}
      onClick={onPress}
      className={`shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-default/30 ${className ?? 'h-9 w-9'}`}
    >
      {src ? (
        <img src={src} alt={alt ?? ''} className="h-full w-full object-cover" />
      ) : blob.isError ? (
        <IconImageOff className="m-auto h-4 w-4 text-muted" />
      ) : null}
    </button>
  )
}

function IconImageOff(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83" />
      <path d="M13.5 13.5 6 21" />
      <path d="M18 12l3 3" />
      <path d="M3.59 3.59A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14a2 2 0 0 0 1.41-.59" />
      <path d="M21 15V5a2 2 0 0 0-2-2H9" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  )
}
