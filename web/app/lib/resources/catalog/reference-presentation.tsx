/**
 * 本地 ReferencePresentation：React 下拉项/回填渲染。
 * lookup 的 label/search/subtitle/default sort 归目标资源 Catalog；
 * 本模块只负责如何用这些字段画 UI，不声明第二份搜索事实。
 */
import type { ReactNode } from 'react'
import type { ResourceLookupMeta } from '@synie/shared'
import type { Row } from '~/components/synie-data-grid/types'
import { resolveResourceLookup } from './lookups'

export interface ReferencePresentation {
  resource: string
  lookup: ResourceLookupMeta
  /** 下拉项：主行 label + 副行 subtitleFields */
  renderItem: (row: Row) => ReactNode
  /** 选中回填：默认 label */
  renderValue: (row: Row) => ReactNode
  optionLabel: (row: Row | null | undefined) => string
}

function subtitleText(row: Row, fields: string[] | undefined): string {
  if (!fields?.length) return ''
  return fields
    .map((f) => row[f])
    .filter((v) => v != null && String(v).trim() !== '')
    .map(String)
    .join(' · ')
}

export function createReferencePresentation(
  resource: string,
  labelFieldOverride?: string,
): ReferencePresentation {
  const lookup = resolveResourceLookup(resource, labelFieldOverride ?? 'name')
  const labelField = labelFieldOverride ?? lookup.labelField

  const optionLabel = (row: Row | null | undefined): string => {
    if (!row) return ''
    const value = row[labelField]
    return value == null ? String(row.id).slice(0, 8) : String(value)
  }

  return {
    resource,
    lookup,
    optionLabel,
    renderItem: (row) => {
      const sub = subtitleText(row, lookup.subtitleFields)
      if (!sub) return optionLabel(row)
      return (
        <div className="flex flex-col gap-0.5">
          <span>{optionLabel(row)}</span>
          <span className="text-xs text-ink-500">{sub}</span>
        </div>
      )
    },
    renderValue: (row) => optionLabel(row),
  }
}
