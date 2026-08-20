import { useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { Sheet } from '@heroui-pro/react'
import { Button, Chip, CloseButton, ListBox, Popover } from '@heroui/react'
import { FilterControl, filterSummary } from './filter-popover'
import type { ColumnFilter, FilterState, GridColumnMeta } from './types'

// 弹层 portal 到表格外,但 React 合成事件仍可能冒泡回表格树;截断以免抢走输入焦点。
const stopBubble = {
  onKeyDown: (e: KeyboardEvent) => e.key !== 'Escape' && e.stopPropagation(),
  onKeyUp: (e: KeyboardEvent) => e.key !== 'Escape' && e.stopPropagation(),
  onPointerDown: (e: PointerEvent) => e.stopPropagation(),
  onPointerUp: (e: PointerEvent) => e.stopPropagation(),
  onMouseDown: (e: MouseEvent) => e.stopPropagation(),
  onMouseUp: (e: MouseEvent) => e.stopPropagation(),
  onClick: (e: MouseEvent) => e.stopPropagation(),
}

/** 卡片模式触控热区 ≥36px */
const compactHit = 'min-h-9'

function FieldList({
  fields,
  compact,
  onPick,
}: {
  fields: GridColumnMeta[]
  compact?: boolean
  onPick: (col: GridColumnMeta) => void
}) {
  if (fields.length === 0) {
    return <p className="text-sm text-muted">当前可筛字段均已添加。</p>
  }
  return (
    <ListBox
      aria-label="可筛选字段"
      selectionMode="none"
      onAction={(key) => {
        const col = fields.find((c) => c.name === String(key))
        if (col) onPick(col)
      }}
    >
      {fields.map((col) => (
        <ListBox.Item
          key={col.name}
          id={col.name}
          textValue={col.label}
          className={compact ? compactHit : undefined}
        >
          {col.label}
        </ListBox.Item>
      ))}
    </ListBox>
  )
}

function EditorBody({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <FilterControl column={column} filter={filter} onChange={onChange} />
      {filter !== undefined && (
        <Button size="sm" variant="tertiary" className={compactHit} onPress={() => onChange(null)}>
          清除筛选
        </Button>
      )}
    </div>
  )
}

/**
 * 工具栏「筛选」加法器：列出尚未筛选的字段,选后同一 FilterControl,即时生效。
 * 桌面 Popover;卡片模式(<lg)瘦 Sheet,两步「选字段 → 控件」,不一次列出全部列。
 */
export function FilterAdder({
  fields,
  filters,
  onChange,
  compact,
}: {
  fields: GridColumnMeta[]
  filters: FilterState
  onChange: (name: string, f: ColumnFilter | null) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<GridColumnMeta | null>(null)

  const close = (next: boolean) => {
    setOpen(next)
    if (!next) setPicked(null)
  }

  const trigger = (
    <Button
      size="sm"
      variant="secondary"
      className={compact ? compactHit : undefined}
      aria-label="筛选"
      onPress={compact ? () => setOpen(true) : undefined}
    >
      筛选
    </Button>
  )

  const body = picked ? (
    <>
      {compact && (
        <Button size="sm" variant="ghost" className={compactHit} onPress={() => setPicked(null)}>
          返回
        </Button>
      )}
      <EditorBody
        column={picked}
        filter={filters[picked.name]}
        onChange={(f) => onChange(picked.name, f)}
      />
    </>
  ) : (
    <FieldList fields={fields} compact={compact} onPick={setPicked} />
  )

  if (compact) {
    return (
      <>
        {trigger}
        <Sheet isOpen={open} onOpenChange={close} isHandleOnly>
          <Sheet.Backdrop>
            <Sheet.Content className="mx-auto max-h-[80vh] w-full max-w-[360px]">
              <Sheet.Dialog aria-label={picked ? `筛选 ${picked.label}` : '筛选'}>
                <Sheet.Handle />
                <Sheet.CloseTrigger />
                <Sheet.Header>
                  <Sheet.Heading>{picked ? picked.label : '筛选'}</Sheet.Heading>
                </Sheet.Header>
                <Sheet.Body className="flex flex-col gap-3 overflow-y-auto">{body}</Sheet.Body>
                <Sheet.Footer>
                  <Sheet.Close>
                    <Button variant="primary" className={`w-full ${compactHit}`}>
                      完成
                    </Button>
                  </Sheet.Close>
                </Sheet.Footer>
              </Sheet.Dialog>
            </Sheet.Content>
          </Sheet.Backdrop>
        </Sheet>
      </>
    )
  }

  return (
    <Popover isOpen={open} onOpenChange={close}>
      {trigger}
      <Popover.Content placement="bottom end" className="w-72">
        <Popover.Dialog className="flex flex-col gap-3 p-3" {...stopBubble}>
          <Popover.Heading className="text-sm font-medium">{picked ? picked.label : '筛选'}</Popover.Heading>
          {picked && (
            <Button size="sm" variant="ghost" onPress={() => setPicked(null)}>
              返回
            </Button>
          )}
          {body}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

function FilterTag({
  column,
  filter,
  onChange,
  compact,
}: {
  column: GridColumnMeta
  filter: ColumnFilter
  onChange: (f: ColumnFilter | null) => void
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const text = `${column.label} ${filterSummary(column, filter)}`

  const editor = (
    <EditorBody column={column} filter={filter} onChange={onChange} />
  )

  const labelButton = (
    <Button
      slot={null}
      variant="ghost"
      size="sm"
      className={`h-auto min-h-6 px-0 font-normal ${compact ? compactHit : ''}`}
      aria-label={`编辑 ${column.label} 筛选`}
      onPress={compact ? () => setOpen(true) : undefined}
    >
      {text}
    </Button>
  )

  return (
    <>
      <Chip size="sm" className={`pr-1 ${compact ? compactHit : ''}`}>
        <Chip.Label>
          {compact ? (
            labelButton
          ) : (
            <Popover isOpen={open} onOpenChange={setOpen}>
              {labelButton}
              <Popover.Content placement="bottom" className="w-72">
                <Popover.Dialog className="flex flex-col gap-3 p-3" {...stopBubble}>
                  <Popover.Heading className="text-sm font-medium">{column.label}</Popover.Heading>
                  {editor}
                </Popover.Dialog>
              </Popover.Content>
            </Popover>
          )}
        </Chip.Label>
        <CloseButton
          aria-label={`清除 ${column.label} 筛选`}
          className={compact ? `${compactHit} min-w-9 [&_svg]:size-3.5` : 'h-4 w-4 [&_svg]:size-3'}
          onPress={() => onChange(null)}
        />
      </Chip>
      {compact && (
        <Sheet isOpen={open} onOpenChange={setOpen} isHandleOnly>
          <Sheet.Backdrop>
            <Sheet.Content className="mx-auto max-h-[80vh] w-full max-w-[360px]">
              <Sheet.Dialog aria-label={`筛选 ${column.label}`}>
                <Sheet.Handle />
                <Sheet.CloseTrigger />
                <Sheet.Header>
                  <Sheet.Heading>{column.label}</Sheet.Heading>
                </Sheet.Header>
                <Sheet.Body className="flex flex-col gap-3 overflow-y-auto">{editor}</Sheet.Body>
                <Sheet.Footer>
                  <Sheet.Close>
                    <Button variant="primary" className={`w-full ${compactHit}`}>
                      完成
                    </Button>
                  </Sheet.Close>
                </Sheet.Footer>
              </Sheet.Dialog>
            </Sheet.Content>
          </Sheet.Backdrop>
        </Sheet>
      )}
    </>
  )
}

/**
 * 已生效筛选标签:「字段 摘要」,点标签编辑,× 清该条件;≥2 显示「清除全部」。
 */
export function FilterTags({
  items,
  onChange,
  onClearAll,
  compact,
}: {
  items: { name: string; column: GridColumnMeta; filter: ColumnFilter }[]
  onChange: (name: string, f: ColumnFilter | null) => void
  onClearAll: () => void
  compact?: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {items.map(({ name, column, filter }) => (
        <FilterTag
          key={name}
          column={column}
          filter={filter}
          onChange={(f) => onChange(name, f)}
          compact={compact}
        />
      ))}
      {items.length >= 2 && (
        <Button size="sm" variant="ghost" className={compact ? compactHit : undefined} onPress={onClearAll}>
          清除全部
        </Button>
      )}
    </div>
  )
}
