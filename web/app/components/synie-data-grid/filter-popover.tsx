import { useState } from 'react'
import { Button, Checkbox, Input, Label, Popover, Switch } from '@heroui/react'
import type { ColumnFilter, GridColumnMeta } from './types'

/** 列头筛选按钮:按列类型出控件,受控于 FilterState */
export function ColumnFilterButton({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const active = filter !== undefined

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={`筛选 ${column.label}`}
        className={active ? 'text-accent' : 'text-muted'}
      >
        <FilterIcon />
      </Button>
      <Popover.Content placement="bottom" className="max-w-72">
        <Popover.Dialog className="flex flex-col gap-3 p-1">
          <Popover.Heading className="text-sm font-medium">{column.label}</Popover.Heading>
          <FilterControl column={column} filter={filter} onChange={onChange} />
          {active && (
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => {
                onChange(null)
                setIsOpen(false)
              }}
            >
              清除筛选
            </Button>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

function FilterControl({
  column,
  filter,
  onChange,
}: {
  column: GridColumnMeta
  filter: ColumnFilter | undefined
  onChange: (f: ColumnFilter | null) => void
}) {
  switch (column.type) {
    case 'boolean':
      return (
        <Switch
          isSelected={filter?.kind === 'bool' ? filter.eq : false}
          onChange={(selected) => onChange({ kind: 'bool', eq: selected })}
        >
          <Switch.Content className="text-sm">
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            仅看「是」
          </Switch.Content>
        </Switch>
      )
    case 'enum':
      return (
        <div className="flex flex-col gap-1">
          {(column.enumOptions ?? []).map((o) => {
            const values = filter?.kind === 'enum' ? filter.values : []
            const checked = values.includes(o.value)
            return (
              <Checkbox
                key={o.value}
                isSelected={checked}
                onChange={(sel) => {
                  const next = sel ? [...values, o.value] : values.filter((v) => v !== o.value)
                  onChange(next.length > 0 ? { kind: 'enum', values: next } : null)
                }}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  {o.label}
                </Checkbox.Content>
              </Checkbox>
            )
          })}
        </div>
      )
    case 'date':
    case 'datetime':
    case 'integer':
    case 'decimal': {
      const isDate = column.type === 'date' || column.type === 'datetime'
      const range: { gte?: string; lte?: string } = filter?.kind === 'range' ? filter : {}
      const update = (patch: { gte?: string; lte?: string }) => {
        const next = { kind: 'range' as const, gte: range.gte, lte: range.lte, ...patch }
        onChange(next.gte || next.lte ? next : null)
      }
      // 后端 datetime 需要完整 ISO;日期输入按当天起止补全
      const toIso = (v: string, end: boolean) =>
        v && column.type === 'datetime' ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : v
      return (
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted">起</Label>
          <Input
            type={isDate ? 'date' : 'number'}
            value={range.gte?.slice(0, 10) ?? ''}
            onChange={(e) => update({ gte: toIso(e.target.value, false) || undefined })}
          />
          <Label className="text-xs text-muted">止</Label>
          <Input
            type={isDate ? 'date' : 'number'}
            value={range.lte?.slice(0, 10) ?? ''}
            onChange={(e) => update({ lte: toIso(e.target.value, true) || undefined })}
          />
        </div>
      )
    }
    default:
      return (
        <Input
          placeholder="包含…"
          value={filter?.kind === 'text' ? filter.contains : ''}
          onChange={(e) =>
            onChange(e.target.value ? { kind: 'text', contains: e.target.value } : null)
          }
        />
      )
  }
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M1.5 3h13l-5 6v4.5l-3-1.5V9l-5-6z" />
    </svg>
  )
}
