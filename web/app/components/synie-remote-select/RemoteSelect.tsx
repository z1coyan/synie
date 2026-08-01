import { useState } from 'react'
import { Autocomplete, Label } from '@heroui/react'
import { useDraft } from '../synie-data-grid/use-debounced'
import type { Row } from '../synie-data-grid/types'
import { RemoteOptionsPopover } from './options-popover'
import { optionLabel, resolveSource, type RemoteSourceConfig } from './remote-query'
import { useRemoteOptions, useRemoteRecords } from './use-remote'

export interface RemoteSelectProps extends RemoteSourceConfig {
  value: string | null
  onChange: (id: string | null, row: Row | null) => void
  label?: string
  placeholder?: string
  isDisabled?: boolean
  isRequired?: boolean
  /** 已有行数据(表格行 join 等)短路回显反查 */
  initialRows?: Row[]
}

export function RemoteSelect(props: RemoteSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  // 草稿即时回显,停稳 300ms 才发请求(useDraft 先例)
  const [draft, setDraft] = useDraft(search, setSearch)
  const options = useRemoteOptions(src, search, open)

  // 回填数据源:initialRows + 已加载选项页 + 反查兜底,后写覆盖前写
  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  for (const r of (options.data?.pages ?? []).flatMap((p) => p.results)) known.set(r.id, r)
  const missing = props.value != null && !known.has(props.value) ? [props.value] : []
  const resolved = useRemoteRecords(src, missing)
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  const selectedRow = props.value != null ? (known.get(props.value) ?? null) : null

  return (
    <Autocomplete
      aria-label={props.label ?? props.placeholder ?? '请选择'}
      value={props.value}
      onChange={(key) => {
        const id = key == null ? null : String(key)
        props.onChange(id, id ? (known.get(id) ?? null) : null)
      }}
      isDisabled={props.isDisabled}
      isRequired={props.isRequired}
      allowsEmptyCollection
      onOpenChange={setOpen}
    >
      {props.label && <Label>{props.label}</Label>}
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {selectedRow ? (
            (props.renderValue?.(selectedRow) ?? optionLabel(src, selectedRow))
          ) : props.value != null ? (
            // 反查未返回(加载中/已删/无权限):截断 id 顶着,不空白
            String(props.value).slice(0, 8)
          ) : (
            <span className="text-muted">{props.placeholder ?? '请选择…'}</span>
          )}
        </Autocomplete.Value>
        <Autocomplete.ClearButton />
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <RemoteOptionsPopover src={src} draft={draft} onDraft={setDraft} options={options} renderItem={props.renderItem} />
    </Autocomplete>
  )
}
