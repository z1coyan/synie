import { useEffect, useRef, useState, type ComponentProps, type SVGProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Modal, Spinner, toast } from '@heroui/react'
import { blobUrl, downloadFile, fetchFileBlob } from '~/lib/files'

/**
 * 通用全屏图片预览(lightbox):右上工具栏(下载/旋转/缩放/关闭),左右箭头循环切换,
 * 方向键切换、滚轮缩放、拖拽平移、点空白处或 ESC 关闭。
 * 底座是受控 Modal(portal 到 body,后开者在上),在 Sheet/Modal 内打开层级天然正确。
 */
export interface SyniePreviewItem {
  /** 直接可渲染的图片地址(objectURL 等);与 fileId 二选一 */
  src?: string
  /** sys_file id,组件内部经鉴权懒加载当前张;与 src 二选一 */
  fileId?: string
  /** 下载保存名/底部标签 */
  filename?: string
}

export interface SyniePreviewProps {
  items: SyniePreviewItem[]
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 每次打开定位到该张,缺省第一张 */
  initialIndex?: number
}

const SCALE_MIN = 0.25
const SCALE_MAX = 8
const INITIAL_VIEW = { scale: 1, rotation: 0, x: 0, y: 0 }

export function SyniePreview({ items, isOpen, onOpenChange, initialIndex }: SyniePreviewProps) {
  const count = items.length
  const [index, setIndex] = useState(0)
  const [view, setView] = useState(INITIAL_VIEW)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // 打开瞬间重置到 initialIndex(render 期调整,避免 effect 先绘一帧旧图)
  const [prevOpen, setPrevOpen] = useState(false)
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen)
    if (isOpen) {
      setIndex(Math.min(initialIndex ?? 0, Math.max(count - 1, 0)))
      setView(INITIAL_VIEW)
    }
  }

  const step = (delta: number) => {
    setIndex((i) => (i + delta + count) % count)
    setView(INITIAL_VIEW)
  }

  const zoom = (delta: 1 | -1) =>
    setView((v) => ({ ...v, scale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, v.scale * (delta > 0 ? 1.25 : 0.8))) }))

  // 方向键循环切换;ESC 关闭由 Modal 自带
  useEffect(() => {
    if (!isOpen || count <= 1) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, count])

  const current = count > 0 ? items[Math.min(index, count - 1)] : undefined

  // fileId 形态经鉴权拉字节;queryKey 与 SynieImageAttachment 同构,缓存互通
  const blob = useQuery({
    queryKey: ['fileBlob', current?.fileId ?? ''],
    enabled: isOpen && !!current?.fileId,
    staleTime: Number.POSITIVE_INFINITY, // 文件内容不可变,替换是换 id
    queryFn: () => fetchFileBlob(current!.fileId!),
  })
  const src = current?.src ?? (blob.data ? blobUrl(blob.data) : null)

  const handleDownload = async () => {
    if (!current) return
    const filename = current.filename ?? 'image'
    try {
      if (current.fileId) {
        await downloadFile(current.fileId, filename)
      } else if (current.src) {
        const a = document.createElement('a')
        a.href = current.src
        a.download = filename
        a.click()
      }
    } catch (e) {
      toast.danger('下载失败', { description: (e as Error).message })
    }
  }

  if (count === 0) return null

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} className="bg-black/80">
      <Modal.Container size="full">
        <Modal.Dialog
          className="relative h-full w-full max-w-none rounded-none border-none bg-transparent p-0 shadow-none"
          aria-label={current?.filename ?? '图片预览'}
        >
          {/* 展示区:点空白处关闭,滚轮缩放 */}
          <div
            className="absolute inset-0 flex items-center justify-center overflow-hidden"
            onClick={(e) => e.target === e.currentTarget && onOpenChange(false)}
            onWheel={(e) => zoom(e.deltaY < 0 ? 1 : -1)}
          >
            {current?.fileId && blob.isLoading ? (
              <Spinner className="text-white" />
            ) : current?.fileId && blob.isError ? (
              <span className="px-6 text-sm text-danger">图片加载失败:{(blob.error as Error).message}</span>
            ) : src ? (
              <img
                src={src}
                alt={current?.filename ?? '预览图片'}
                draggable={false}
                className={`max-h-full max-w-full cursor-grab object-contain select-none active:cursor-grabbing ${dragging ? '' : 'transition-transform duration-200'}`}
                style={{ transform: `translate(${view.x}px, ${view.y}px) rotate(${view.rotation}deg) scale(${view.scale})` }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                  dragRef.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y }
                  setDragging(true)
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current
                  if (d) setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }))
                }}
                onPointerUp={() => {
                  dragRef.current = null
                  setDragging(false)
                }}
                onPointerCancel={() => {
                  dragRef.current = null
                  setDragging(false)
                }}
              />
            ) : null}
          </div>

          {/* 工具栏:下载/旋转/缩小/放大/关闭 */}
          <div className="absolute end-4 top-4 flex items-center gap-1 rounded-full bg-black/50 p-1">
            <ToolButton label="下载" onPress={handleDownload}>
              <IconDownload className="size-5" />
            </ToolButton>
            <ToolButton label="旋转" onPress={() => setView((v) => ({ ...v, rotation: v.rotation + 90 }))}>
              <IconRotateCw className="size-5" />
            </ToolButton>
            <ToolButton label="缩小" isDisabled={view.scale <= SCALE_MIN} onPress={() => zoom(-1)}>
              <IconZoomOut className="size-5" />
            </ToolButton>
            <ToolButton label="放大" isDisabled={view.scale >= SCALE_MAX} onPress={() => zoom(1)}>
              <IconZoomIn className="size-5" />
            </ToolButton>
            <ToolButton label="关闭" onPress={() => onOpenChange(false)}>
              <IconClose className="size-5" />
            </ToolButton>
          </div>

          {/* 左右循环切换,单张不显示 */}
          {count > 1 && (
            <>
              <div className="absolute start-4 top-1/2 -translate-y-1/2">
                <ToolButton label="上一张" className="bg-black/50" onPress={() => step(-1)}>
                  <IconChevronLeft className="size-6" />
                </ToolButton>
              </div>
              <div className="absolute end-4 top-1/2 -translate-y-1/2">
                <ToolButton label="下一张" className="bg-black/50" onPress={() => step(1)}>
                  <IconChevronRight className="size-6" />
                </ToolButton>
              </div>
            </>
          )}

          {/* 底部:计数 + 文件名 */}
          {(count > 1 || current?.filename) && (
            <div className="absolute bottom-4 start-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1 text-xs text-white/90">
              {count > 1 && `${Math.min(index, count - 1) + 1} / ${count}`}
              {count > 1 && current?.filename && ' · '}
              {current?.filename}
            </div>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function ToolButton({
  label,
  className,
  ...props
}: { label: string; className?: string } & Pick<ComponentProps<typeof Button>, 'onPress' | 'isDisabled' | 'children'>) {
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={label}
      className={`rounded-full text-white hover:bg-white/20 ${className ?? ''}`}
      {...props}
    />
  )
}

// 项目无图标库,与 SynieDataGrid 同款手写内联 SVG(lucide 风格)
function Svg(props: SVGProps<SVGSVGElement>) {
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
    />
  )
}

function IconDownload(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </Svg>
  )
}

function IconRotateCw(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  )
}

function IconZoomIn(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" x2="16.65" y1="21" y2="16.65" />
      <line x1="11" x2="11" y1="8" y2="14" />
      <line x1="8" x2="14" y1="11" y2="11" />
    </Svg>
  )
}

function IconZoomOut(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" x2="16.65" y1="21" y2="16.65" />
      <line x1="8" x2="14" y1="11" y2="11" />
    </Svg>
  )
}

function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  )
}

function IconChevronLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  )
}

function IconChevronRight(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  )
}
