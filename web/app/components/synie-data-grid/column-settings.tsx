import { Button, Checkbox, Popover } from '@heroui/react'
import { IconSettings } from '~/components/icons'
import {
  ATTACHMENT_IMAGES_COLUMN,
  moveVisibleColumn,
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
 * 可见列在上（可上下移），隐藏列在下；至少保留一列可见。
 */
export function ColumnSettingsButton(props: ColumnSettingsButtonProps) {
  const { items, order, onOrderChange, onReset, isCustomized } = props
  const byName = new Map(items.map((i) => [i.name, i]))
  const visible = order.flatMap((n) => {
    const item = byName.get(n)
    return item ? [item] : []
  })
  const hidden = items.filter((i) => !order.includes(i.name))
  const onlyOne = order.length <= 1

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
          <p className="text-xs text-muted">勾选显示列，箭头调整顺序。至少保留一列。</p>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {visible.map((item, index) => (
              <ColumnRow
                key={item.name}
                item={item}
                checked
                onlyOne={onlyOne}
                canUp={index > 0}
                canDown={index < visible.length - 1}
                onToggle={(on) => onOrderChange(toggleColumnVisible(order, item.name, on))}
                onUp={() => onOrderChange(moveVisibleColumn(order, item.name, -1))}
                onDown={() => onOrderChange(moveVisibleColumn(order, item.name, 1))}
              />
            ))}
            {hidden.map((item) => (
              <ColumnRow
                key={item.name}
                item={item}
                checked={false}
                onlyOne={false}
                canUp={false}
                canDown={false}
                onToggle={(on) => onOrderChange(toggleColumnVisible(order, item.name, on))}
                onUp={() => {}}
                onDown={() => {}}
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
  canUp: boolean
  canDown: boolean
  onToggle: (on: boolean) => void
  onUp: () => void
  onDown: () => void
}) {
  const { item, checked, onlyOne, canUp, canDown, onToggle, onUp, onDown } = props
  const label =
    item.name === ATTACHMENT_IMAGES_COLUMN ? item.label : item.label || item.name

  return (
    <li className="flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-default/40">
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
      {checked && (
        <div className="flex shrink-0 items-center">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={`上移 ${label}`}
            isDisabled={!canUp}
            onPress={onUp}
            className="h-7 w-7 min-w-7"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={`下移 ${label}`}
            isDisabled={!canDown}
            onPress={onDown}
            className="h-7 w-7 min-w-7"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </li>
  )
}

function ChevronUp({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m18 15-6-6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
