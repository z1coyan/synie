import type { MouseEvent, ReactNode } from 'react'
import { EmptyState } from '@heroui-pro/react'
import { Card, Checkbox } from '@heroui/react'
import { FileThumb } from '../synie-preview/FileThumb'
import type { CardFields } from './card-fields'
import { cellContent, imageFileId, imageFilename, type ColumnOverride } from './cells'
import { RowActionsMenu } from './row-menu'
import type { GridColumnMeta, Row } from './types'
import type { ResolvedAction } from './use-grid-actions'

/** 卡片选择机制:multiple 出勾选位(批量动作/多选选择器),single 点卡片即切换(单选选择器) */
export interface CardSelection {
  mode: 'single' | 'multiple'
  isSelected: (row: Row) => boolean
  onToggle: (row: Row) => void
}

export interface CardListProps {
  rows: Row[]
  /** 当前展示列(meta 顺序,已应用 columns/exclude) */
  columns: GridColumnMeta[]
  /** 卡片字段角色映射(cardFields 推导) */
  fields: CardFields
  overrides: Record<string, ColumnOverride>
  /** 点卡片打开详情;未传则卡片不响应点击(single 选择时点击改为切换选中) */
  onView?: (row: Row) => void
  /** 行内 ⋯ 菜单(传了才渲染菜单位);返回空数组的卡片不出菜单 */
  rowMenuFor?: (row: Row) => ResolvedAction[]
  /** 选择机制(批量动作 mobile:true 或 pick 选择器时传入) */
  selection?: CardSelection
  /** 图片列(image override)缩略图点击:父级开全屏预览(与表格同状态) */
  onImagePress?: (colName: string, row: Row) => void
  /** 卡片左侧首图位(附件图片列);未传不渲染 */
  renderLeading?: (row: Row) => ReactNode
}

/** 事件源落在交互元素(fk 链接/⋯ 菜单/勾选框等)内时不触发卡片点击——
 * 避免点 fk 链接同时弹速览与详情两个抽屉。不含 [role="button"]:卡片自身即该角色,会恒真 */
const isInteractiveTarget = (e: MouseEvent) =>
  (e.target as HTMLElement).closest('button, a, input, [data-slot="checkbox"]') != null

/**
 * 卡片模式列表(<lg 视口替代 DataGrid):每条记录一张卡片——
 * 标题/副标题/摘要按 CardFields 角色渲染,点卡片进详情,⋯ 菜单给行内动作。
 * 注意:Card 是普通 div 无 onPress,且卡内嵌 ⋯ 按钮不能整体套 RAC Button(非法嵌套),
 * 故点击语义用 div onClick+键盘事件实现——这是 onPress 约定的有意例外。
 */
/** 摘要值渲染:image override 列出缩略图(点击全屏预览),其余走 cellContent */
function summaryValue(
  col: GridColumnMeta,
  row: Row,
  override: ColumnOverride | undefined,
  onImagePress?: (colName: string, row: Row) => void
): ReactNode {
  const img = override?.image
  if (img) {
    const fileId = imageFileId(img, col.name, row)
    if (fileId) {
      const thumb = (
        <FileThumb fileId={fileId} alt={imageFilename(img, row)} onPress={() => onImagePress?.(col.name, row)} />
      )
      if (img !== true && img.keepText) {
        return (
          <span className="flex items-center justify-end gap-2">
            {thumb}
            {cellContent(col, row, override)}
          </span>
        )
      }
      return thumb
    }
  }
  return cellContent(col, row, override)
}

export function CardList({
  rows,
  columns,
  fields,
  overrides,
  onView,
  rowMenuFor,
  selection,
  onImagePress,
  renderLeading,
}: CardListProps) {
  if (rows.length === 0) {
    return (
      <EmptyState size="sm" className="py-10">
        <EmptyState.Header>
          <EmptyState.Title>暂无数据</EmptyState.Title>
          <EmptyState.Description>没有符合条件的记录。</EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    )
  }

  const colByName = new Map(columns.map((c) => [c.name, c]))
  const titleCol = fields.title ? colByName.get(fields.title) : undefined
  const subtitleCol = fields.subtitle ? colByName.get(fields.subtitle) : undefined
  const summaryCols = fields.summary.flatMap((n) => {
    const c = colByName.get(n)
    return c ? [c] : []
  })

  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const menuItems = rowMenuFor?.(row) ?? []
        const selected = selection?.isSelected(row) ?? false
        // single 选择或无 onView 的 multiple(选择器):整卡点击=切换选中;否则点击=打开详情
        const pressRow = selection && (selection.mode === 'single' || !onView) ? selection.onToggle : onView
        return (
          <Card
            key={row.id}
            className={`${pressRow ? 'cursor-pointer' : ''} ${selected ? 'ring-2 ring-accent' : ''}`}
            role={pressRow ? 'button' : undefined}
            tabIndex={pressRow ? 0 : undefined}
            aria-pressed={pressRow && selection ? selected : undefined}
            onClick={pressRow ? (e) => !isInteractiveTarget(e) && pressRow(row) : undefined}
            onKeyDown={
              pressRow
                ? (e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      pressRow(row)
                    }
                  }
                : undefined
            }
          >
            <Card.Header className="flex-row items-start justify-between gap-2 pb-1">
              {renderLeading && (
                // 首图区(附件图片列,无图时为 null):点击预览由 FileThumb 自带 onPress 承载,守卫已挡卡片点击
                <div className="shrink-0">{renderLeading(row)}</div>
              )}
              {selection?.mode === 'multiple' && (
                <Checkbox slot={null} isSelected={selected} onChange={() => selection.onToggle(row)} aria-label="选择该行">
                  <Checkbox.Content>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                  </Checkbox.Content>
                </Checkbox>
              )}
              <div className="min-w-0 flex-1">
                {titleCol && (
                  <Card.Title className="truncate text-base">
                    {cellContent(titleCol, row, overrides[titleCol.name])}
                  </Card.Title>
                )}
                {subtitleCol && (
                  <Card.Description className="truncate">
                    {cellContent(subtitleCol, row, overrides[subtitleCol.name])}
                  </Card.Description>
                )}
              </div>
              {menuItems.length > 0 && <RowActionsMenu items={menuItems} row={row} />}
            </Card.Header>
            {summaryCols.length > 0 && (
              <Card.Content className="flex flex-col gap-1.5 pt-0">
                {summaryCols.map((col) => (
                  <div key={col.name} className="flex items-center justify-between gap-3 text-sm">
                    <span className="shrink-0 text-muted">{overrides[col.name]?.label ?? col.label}</span>
                    <span className="min-w-0 truncate text-right">
                      {summaryValue(col, row, overrides[col.name], onImagePress)}
                    </span>
                  </div>
                ))}
              </Card.Content>
            )}
          </Card>
        )
      })}
    </div>
  )
}
