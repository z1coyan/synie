import { useState, type DragEvent } from 'react'
import { Button, Checkbox, Popover } from '@heroui/react'
import { IconSettings } from '~/components/icons'
import {
  ATTACHMENT_IMAGES_COLUMN,
  moveVisibleColumnTo,
  toggleColumnVisible,
} from './column-prefs'

export interface ColumnSettingsItem {
  name: string
  label: string
}

export interface ColumnSettingsButtonProps {
  /** 候选列（meta 顺序，含合成列） */
  items: ColumnSettingsItem[]
  /** 当前可见有序 */
  order: string[]
  onOrderChange: (next: string[]) => void
  onReset: () => void
  isCustomized: boolean
}

/**
 * 工具栏列设置：小齿轮 + Popover。
 * 可见列在上（可拖拽排序），隐藏列在下；至少保留一列可见。
 */
export function ColumnSettingsButton(props: ColumnSettingsButtonProps) {
  const { items, order, onOrderChange, onReset, isCustomized } = props
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const byName = new Map(items.map((i) => [i.name, i]))
  const visible = order.flatMap((n) => {
    const item = byName.get(n)
    return item ? [item] : []
  })
  const hidden = items.filter((i) => !order.includes(i.name))
  const onlyOne = order.length <= 1

  const onDragStart = (index: number, e: DragEvent) => {
    setDragFrom(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }

  const onDragOverRow = (index: number, e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOver !== index) setDragOver(index)
  }

  const onDropRow = (toIndex: number, e: DragEvent) => {
    e.preventDefault()
    const from = dragFrom ?? Number(e.dataTransfer.getData('text/plain'))
    if (Number.isFinite(from)) {
      onOrderChange(moveVisibleColumnTo(order, from, toIndex))
    }
    setDragFrom(null)
    setDragOver(null)
  }

  const onDragEnd = () => {
    setDragFrom(null)
    setDragOver(null)
  }

  return (
    <Popover>
      <Button size="sm" variant="secondary" isIconOnly aria-label="列设置">
        <IconSettings className="h-4 w-4" />
      </Button>
      <Popover.Content placement="bottom end" className="w-80">
        <Popover.Dialog className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <Popover.Heading className="text-sm font-medium">列显示</Popover.Heading>
            <Button size="sm" variant="ghost" isDisabled={!isCustomized} onPress={onReset}>
              恢复默认
            </Button>
          </div>
          <p className="text-xs text-muted">勾选显示列，拖拽调整顺序。至少保留一列。</p>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {visible.map((item, index) => (
              <ColumnRow
                key={item.name}
                item={item}
                checked
                onlyOne={onlyOne}
                draggable
                isDragging={dragFrom === index}
                isDropTarget={dragOver === index && dragFrom !== index}
                onToggle={(on) => onOrderChange(toggleColumnVisible(order, item.name, on))}
                onDragStart={(e) => onDragStart(index, e)}
                onDragOver={(e) => onDragOverRow(index, e)}
                onDrop={(e) => onDropRow(index, e)}
                onDragEnd={onDragEnd}
              />
            ))}
            {hidden.map((item) => (
              <ColumnRow
                key={item.name}
                item={item}
                checked={false}
                onlyOne={false}
                draggable={false}
                isDragging={false}
                isDropTarget={false}
                onToggle={(on) => onOrderChange(toggleColumnVisible(order, item.name, on))}
                onDragStart={() => {}}
                onDragOver={() => {}}
                onDrop={() => {}}
                onDragEnd={() => {}}
              />
            ))}
          </ul>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

function ColumnRow(props: {
  item: ColumnSettingsItem
  checked: boolean
  onlyOne: boolean
  draggable: boolean
  isDragging: boolean
  isDropTarget: boolean
  onToggle: (on: boolean) => void
  onDragStart: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
}) {
  const {
    item,
    checked,
    onlyOne,
    draggable,
    isDragging,
    isDropTarget,
    onToggle,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
  } = props
  const label =
    item.name === ATTACHMENT_IMAGES_COLUMN ? item.label : item.label || item.name

  return (
    <li
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? onDragOver : undefined}
      onDrop={draggable ? onDrop : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      className={[
        'flex h-8 items-center gap-1 rounded-md px-1',
        draggable ? 'cursor-grab active:cursor-grabbing' : '',
        isDragging ? 'opacity-40' : 'hover:bg-default/40',
        isDropTarget ? 'bg-accent/10 ring-1 ring-accent/40' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* 统一占位：可见行可拖，隐藏行同宽透明，保证行高/对齐一致 */}
      <span
        className={[
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          draggable ? 'text-muted' : 'invisible',
        ].join(' ')}
        aria-hidden={!draggable}
        title={draggable ? '拖拽排序' : undefined}
      >
        <GripIcon className="h-3.5 w-3.5" />
      </span>
      <Checkbox
        isSelected={checked}
        isDisabled={checked && onlyOne}
        onChange={onToggle}
        className="min-w-0 flex-1"
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          <span className="truncate text-sm">{label}</span>
        </Checkbox.Content>
      </Checkbox>
    </li>
  )
}

function GripIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </svg>
  )
}
