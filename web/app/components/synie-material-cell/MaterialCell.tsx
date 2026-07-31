import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@heroui/react'
import {
  attachmentListKey,
  fetchAttachmentList,
  type AttachmentRow,
} from '../synie-attachment-panel/attachments'
import { FileThumb } from '../synie-preview/FileThumb'
import { SyniePreview } from '../synie-preview/SyniePreview'
import { useFkPreview } from '../synie-record-drawer/fk-preview'
import type { Row } from '../synie-data-grid/types'

/**
 * 物料单元格:全系统只读表格统一的物料展示形式(约定见 web/AGENTS.md)。
 *
 * 布局:左 40px 图纸缩略图,右侧三行——「编号 名称」/「规格:xx」/「客编:xx」,
 * 规格/客编为空整行省略;编号为 link,点击开物料全局速览抽屉(无 materialId 退纯文本)。
 *
 * 数据口径:
 * - 文本四字段(编号/名称/规格/客编)严格取行上快照值,空值不回退物料主数据;
 *   无快照的表(库存余额/分录、物料列表自身)行上本就是物料主数据投影,同一渲染路径。
 * - 缩略图快照图纸挂接优先(行 ownerType/category 的 sys_attachment 首图),
 *   无挂接回退物料主数据当前图纸(inv_material/drawing 首图),仍无图显示占位图标;
 *   点击缩略图全屏预览当前来源的全部图片。
 * - 取数复用附件列表 queryKey(与附件面板/虚拟列同缓存,同物料跨行去重),前端零后端改动。
 *
 * 行字段约定:materialCode/materialName/materialSpec/customerPartNo/materialId(无快照的表
 * 用物料主数据同名字段);DataGrid 撤列后这些字段经 extraFields 继续取回。
 */
export interface MaterialCellOptions {
  /** 行图纸挂接的 ownerType(如 sal_order_item);行无图纸挂接的快照/主数据行省略 */
  drawingOwnerType?: string
  /** 行图纸挂接 category,缺省 drawing */
  drawingCategory?: string
}

function imagesOf(list: AttachmentRow[] | undefined): AttachmentRow[] {
  return (list ?? []).filter((r) => r.file.contentType?.startsWith('image/'))
}

export function MaterialCell({ row, options }: { row: Row; options?: MaterialCellOptions }) {
  const openPreview = useFkPreview()
  const [previewOpen, setPreviewOpen] = useState(false)

  const code = row.materialCode != null ? String(row.materialCode) : ''
  const name = row.materialName != null ? String(row.materialName) : ''
  const spec = row.materialSpec != null && row.materialSpec !== '' ? String(row.materialSpec) : null
  const customerPartNo =
    row.customerPartNo != null && row.customerPartNo !== '' ? String(row.customerPartNo) : null
  const materialId = row.materialId != null && row.materialId !== '' ? String(row.materialId) : null

  const drawingOwnerType = options?.drawingOwnerType
  const drawingCategory = options?.drawingCategory ?? 'drawing'

  // 快照图纸挂接(行级):有挂接约定的行才查;新建行(local: id)查不到自然落空回退物料图纸
  const rowDrawing = useQuery({
    queryKey: attachmentListKey(drawingOwnerType ?? '', row.id, drawingCategory),
    staleTime: 30_000,
    enabled: drawingOwnerType != null,
    queryFn: () => fetchAttachmentList(drawingOwnerType!, row.id, drawingCategory),
  })
  const rowImages = imagesOf(rowDrawing.data)

  // 物料主数据当前图纸(回退):无行挂接约定,或行挂接查完为空/失败时启用
  const fallbackActive =
    materialId != null &&
    (drawingOwnerType == null ||
      (rowDrawing.isSuccess && rowImages.length === 0) ||
      rowDrawing.isError)
  const materialDrawing = useQuery({
    queryKey: attachmentListKey('inv_material', materialId, 'drawing'),
    staleTime: 30_000,
    enabled: fallbackActive,
    queryFn: () => fetchAttachmentList('inv_material', materialId!, 'drawing'),
  })
  const materialImages = imagesOf(materialDrawing.data)

  // 当前生效来源:行挂接有图用行挂接,否则物料图纸
  const active = rowImages.length > 0 ? rowImages : materialImages
  const thumb = active[0]

  return (
    <span className="flex min-w-0 items-center gap-2 py-0.5">
      {thumb ? (
        <>
          <FileThumb
            fileId={thumb.file.id}
            alt={thumb.file.filename}
            className="h-10 w-10"
            onPress={() => setPreviewOpen(true)}
          />
          <SyniePreview
            items={active.map((r) => ({ fileId: r.file.id, filename: r.file.filename }))}
            isOpen={previewOpen}
            onOpenChange={setPreviewOpen}
          />
        </>
      ) : (
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-default/30 text-muted"
        >
          <IconImage className="h-4 w-4" />
        </span>
      )}
      <span className="flex min-w-0 max-w-72 flex-col gap-0.5 text-sm leading-snug">
        {code || name ? (
          <span className="truncate">
            {code ? (
              materialId ? (
                <Link
                  onPress={() => openPreview('invMaterials', materialId)}
                  className="cursor-pointer text-inherit underline-offset-2 hover:underline"
                >
                  {code}
                </Link>
              ) : (
                code
              )
            ) : null}
            {code && name ? <span className="text-muted">{'　'}</span> : null}
            {name}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
        {spec ? (
          <span className="truncate text-xs text-muted" title={spec}>
            规格:{spec}
          </span>
        ) : null}
        {customerPartNo ? (
          <span className="truncate text-xs text-muted" title={customerPartNo}>
            客编:{customerPartNo}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/** overrides.render 工厂:DataGrid/EditableTable/审核弹窗三处同一接法 */
export function materialCellRender(options?: MaterialCellOptions) {
  return (_value: unknown, row: Row) => <MaterialCell row={row} options={options} />
}

function IconImage({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  )
}
