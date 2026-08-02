/**
 * 网格查询状态（搜索/筛选/分页/排序）可选同步到 URL search。
 *
 * - enabled=true：URL 为事实源，前进后退与刷新可恢复；写 search 一律函数式 merge。
 * - enabled=false：纯本地 useState（内嵌网格/选择器默认关闭）。
 */

import { useCallback, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  DEFAULT_PAGE_SIZE,
  encodeGridUrlPatch,
  mergeGridUrlSearch,
  parseGridUrlSearch,
  type GridUrlState,
} from '~/lib/url-grid-state'
import type { FilterState, SortState } from './types'

export interface UseUrlGridStateOptions {
  /** 是否把状态写入 URL；内嵌网格传 false */
  enabled: boolean
  defaultSort?: SortState | null
  defaultFilters?: FilterState
  defaultPageSize?: number
}

export interface GridQueryState {
  page: number
  pageSize: number
  sort: SortState | null
  filters: FilterState
  search: string
  setPage: (page: number | ((prev: number) => number)) => void
  setPageSize: (pageSize: number) => void
  setSort: (sort: SortState | null | ((prev: SortState | null) => SortState | null)) => void
  setFilters: (filters: FilterState | ((prev: FilterState) => FilterState)) => void
  setSearch: (search: string) => void
}

function resolveUpdater<T>(next: T | ((prev: T) => T), prev: T): T {
  return typeof next === 'function' ? (next as (p: T) => T)(prev) : next
}

/**
 * 页面级网格默认 enabled；pick/显式 urlState={false} 时走本地状态。
 * 无 validateSearch 的路由也可用：useSearch({ strict: false }) 松散读取。
 */
export function useUrlGridState(options: UseUrlGridStateOptions): GridQueryState {
  const {
    enabled,
    defaultSort = null,
    defaultFilters = {},
    defaultPageSize = DEFAULT_PAGE_SIZE,
  } = options

  const defaults = {
    sort: defaultSort,
    filters: defaultFilters,
    pageSize: defaultPageSize,
  }

  // 本地模式（内嵌网格）；hooks 顺序固定，enabled 时本地 state 闲置
  const [localPage, setLocalPage] = useState(1)
  const [localPageSize, setLocalPageSize] = useState(defaultPageSize)
  const [localSort, setLocalSort] = useState<SortState | null>(defaultSort)
  const [localFilters, setLocalFilters] = useState<FilterState>(defaultFilters)
  const [localSearch, setLocalSearch] = useState('')

  // 松散读取：不要求路由声明 validateSearch；与 record/mode 等同页共存
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()

  const commitUrl = useCallback(
    (state: GridUrlState) => {
      const patch = encodeGridUrlPatch(state, defaults)
      void navigate({
        // 函数式更新 + 只补丁网格键，保留 record/mode/tab 等未知参数
        search: ((prev: Record<string, unknown>) =>
          mergeGridUrlSearch(prev ?? {}, patch)) as never,
      })
    },
    // defaults 字段稳定引用由调用方保证（defaultFilters 模块级或 memo）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, defaultSort, defaultFilters, defaultPageSize],
  )

  if (!enabled) {
    return {
      page: localPage,
      pageSize: localPageSize,
      sort: localSort,
      filters: localFilters,
      search: localSearch,
      setPage: (next) => setLocalPage((prev) => resolveUpdater(next, prev)),
      setPageSize: (size) => {
        setLocalPageSize(size)
        setLocalPage(1)
      },
      setSort: (next) => {
        setLocalSort((prev) => resolveUpdater(next, prev))
        setLocalPage(1)
      },
      setFilters: (next) => {
        setLocalFilters((prev) => resolveUpdater(next, prev))
        setLocalPage(1)
      },
      setSearch: (value) => {
        setLocalSearch(value)
        setLocalPage(1)
      },
    }
  }

  const parsed = parseGridUrlSearch(rawSearch, defaults)

  const write = (partial: Partial<GridUrlState>) => {
    commitUrl({ ...parsed, ...partial })
  }

  return {
    page: parsed.page,
    pageSize: parsed.pageSize,
    sort: parsed.sort,
    filters: parsed.filters,
    search: parsed.search,
    setPage: (next) => write({ page: resolveUpdater(next, parsed.page) }),
    setPageSize: (pageSize) => write({ pageSize, page: 1 }),
    setSort: (next) => {
      const sort = resolveUpdater(next, parsed.sort)
      write({ sort, page: 1 })
    },
    setFilters: (next) => {
      const filters = resolveUpdater(next, parsed.filters)
      write({ filters, page: 1 })
    },
    setSearch: (search) => write({ search, page: 1 }),
  }
}

/**
 * 是否启用 URL 状态：显式 urlState 优先；否则 pick 选择器默认关，页面网格默认开。
 */
export function resolveUrlStateEnabled(
  urlState: boolean | undefined,
  pick: 'single' | 'multiple' | undefined,
): boolean {
  if (urlState != null) return urlState
  return pick == null
}
