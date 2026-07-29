import { Button, Dropdown, Label } from '@heroui/react'
import type { Row } from './types'
import type { ResolvedAction } from './use-grid-actions'

/** 行内 ⋯ 动作菜单:DataGrid 动作列与卡片模式共用 */
export function RowActionsMenu({ items, row }: { items: ResolvedAction[]; row: Row }) {
  return (
    <Dropdown>
      <Button isIconOnly size="sm" variant="ghost" aria-label="行操作">
        <EllipsisIcon />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu onAction={(key) => items.find((a) => a.key === key)?.run([row])}>
          {items.map((a) => (
            <Dropdown.Item key={a.key} id={a.key} textValue={a.label} variant={a.isDanger ? 'danger' : undefined}>
              <Label>{a.label}</Label>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="8" cy="13" r="1.5" />
    </svg>
  )
}
