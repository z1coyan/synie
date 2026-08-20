import { useState } from 'react'
import { Autocomplete, Label, Tag, TagGroup } from '@heroui/react'
import { useDraft } from '../synie-data-grid/use-debounced'
import type { Row } from '../synie-data-grid/types'
import { RemoteOptionsPopover } from './options-popover'
import {
  defaultReferenceRenderers,
  optionLabel,
  resolveSource,
  type RemoteSourceConfig,
} from './remote-query'
import { useRemoteOptions, useRemoteRecords } from './use-remote'

export interface RemoteMultiSelectProps extends RemoteSourceConfig {
  value: string[]
  /** rows 只含已知行数据(缺失 id 不凑数),labels 兜底由调用方截断 id */
  onChange: (ids: string[], rows: Row[]) => void
  label?: string
  placeholder?: string
  isDisabled?: boolean
  isRequired?: boolean
  initialRows?: Row[]
}

export function RemoteMultiSelect(props: RemoteMultiSelectProps) {
  const src = resolveSource(props)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useDraft(search, setSearch)
  const options = useRemoteOptions(src, search, open)

  const known = new Map<string, Row>()
  for (const r of props.initialRows ?? []) known.set(r.id, r)
  for (const r of (options.data?.pages ?? []).flatMap((p) => p.results)) known.set(r.id, r)
  const resolved = useRemoteRecords(src, props.value.filter((id) => !known.has(id)))
  for (const r of resolved.data ?? []) known.set(r.id, r)

  if (!src) return null
  // 无页面级 renderValue 时吃 ReferencePresentation 默认（物料为「编号：名称」）
  const valueOf = props.renderValue ?? defaultReferenceRenderers(src.resource, src.labelField).renderValue
  const rowsFor = (ids: string[]) => ids.map((id) => known.get(id)).filter((r): r is Row => r != null)
  const emit = (ids: string[]) => props.onChange(ids, rowsFor(ids))
  const labelOf = (id: string) => {
    const row = known.get(id)
    if (!row) return id.slice(0, 8)
    const rendered = valueOf(row)
    return typeof rendered === 'string' || typeof rendered === 'number' ? String(rendered) : optionLabel(src, row)
  }

  return (
    <Autocomplete
      size="sm"
      aria-label={props.label ?? props.placeholder ?? '请选择'}
      selectionMode="multiple"
      value={props.value}
      onChange={(keys) => emit(keys.map(String))}
      isDisabled={props.isDisabled}
      isRequired={props.isRequired}
      allowsEmptyCollection
      onOpenChange={setOpen}
    >
      {props.label && <Label>{props.label}</Label>}
      <Autocomplete.Trigger>
        <Autocomplete.Value>
          {props.value.length === 0 ? (
            <span className="text-muted">{props.placeholder ?? '请选择…'}</span>
          ) : (
            <TagGroup
              size="sm"
              aria-label="已选"
              onRemove={(keys) => {
                const removed = new Set([...keys].map(String))
                emit(props.value.filter((id) => !removed.has(id)))
              }}
            >
              <TagGroup.List>
                {props.value.map((id) => {
                  const row = known.get(id)
                  return (
                    <Tag key={id} id={id} textValue={labelOf(id)}>
                      {row ? valueOf(row) : id.slice(0, 8)}
                    </Tag>
                  )
                })}
              </TagGroup.List>
            </TagGroup>
          )}
        </Autocomplete.Value>
        <Autocomplete.ClearButton />
        <Autocomplete.Indicator />
      </Autocomplete.Trigger>
      <RemoteOptionsPopover src={src} draft={draft} onDraft={setDraft} options={options} renderItem={props.renderItem} />
    </Autocomplete>
  )
}
