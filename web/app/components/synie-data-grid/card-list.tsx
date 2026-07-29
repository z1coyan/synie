import type { MouseEvent } from 'react'
import { EmptyState } from '@heroui-pro/react'
import { Card } from '@heroui/react'
import type { CardFields } from './card-fields'
import { cellContent, type ColumnOverride } from './cells'
import { RowActionsMenu } from './row-menu'
import type { GridColumnMeta, Row } from './types'
import type { ResolvedAction } from './use-grid-actions'

export interface CardListProps {
  rows: Row[]
  /** 当前展示列(meta 顺序,已应用 columns/exclude) */
  columns: GridColumnMeta[]
  /** 卡片字段角色映射(cardFields 推导) */
  fields: CardFields
  overrides: Record<string, ColumnOverride>
  /** 点卡片打开详情;未传则卡片不响应点击 */
  onView?: (row: Row) => void
  /** 行内 ⋯ 菜单(传了才渲染菜单位);返回空数组的卡片不出菜单 */
  rowMenuFor?: (row: Row) => ResolvedAction[]
}

/** 事件源落在原生交互元素(fk 链接/⋯ 菜单等 button/a)内时不触发卡片点击——
 * 避免点 fk 链接同时弹速览与详情两个抽屉。不含 [role="button"]:卡片自身即该角色,会恒真 */
const isInteractiveTarget = (e: MouseEvent) =>
  (e.target as HTMLElement).closest('button, a') != null

/**
 * 卡片模式列表(<lg 视口替代 DataGrid):每条记录一张卡片——
 * 标题/副标题/摘要按 CardFields 角色渲染,点卡片进详情,⋯ 菜单给行内动作。
 * 注意:Card 是普通 div 无 onPress,且卡内嵌 ⋯ 按钮不能整体套 RAC Button(非法嵌套),
 * 故点击语义用 div onClick+键盘事件实现——这是 onPress 约定的有意例外。
 */
export function CardList({ rows, columns, fields, overrides, onView, rowMenuFor }: CardListProps) {
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
        return (
          <Card
            key={row.id}
            className={onView ? 'cursor-pointer' : undefined}
            role={onView ? 'button' : undefined}
            tabIndex={onView ? 0 : undefined}
            onClick={onView ? (e) => !isInteractiveTarget(e) && onView(row) : undefined}
            onKeyDown={
              onView
                ? (e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault()
                      onView(row)
                    }
                  }
                : undefined
            }
          >
            <Card.Header className="flex-row items-start justify-between gap-2 pb-1">
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
                    <span className="min-w-0 truncate text-right">{cellContent(col, row, overrides[col.name])}</span>
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
