import { useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { DataGrid, EmptyState, InlineSelect, type DataGridColumn, type DataGridSortDescriptor } from '@heroui-pro/react'
import { Button, Chip, ListBox, Pagination, Spinner } from '@heroui/react'
import type { Selection } from 'react-aria-components'
import { gqlFetch } from '~/lib/graphql'
import { useGridMeta } from './meta'
import { buildFilterLiteral, buildRowQuery, toSortLiteral } from './query'
import type { ActionContext, BulkAction, FilterState, GridColumnMeta, Row, RowAction, SortState } from './types'

export interface ColumnOverride {
  render?: (value: unknown, row: Row) => ReactNode
  label?: string
  width?: number
}

export interface SynieDataGridProps {
  /** 与后端 GridMeta 白名单同名,如 "sysRoles" */
  resource: string
  exclude?: string[]
  overrides?: Record<string, ColumnOverride>
  onCreate?: () => void
  onEdit?: (row: Row) => void
  onImport?: (ctx: ActionContext) => void
  onPrint?: (rows: Row[]) => void
  actionHandlers?: Record<string, (rows: Row[], ctx: ActionContext) => void>
  bulkActions?: BulkAction[]
  rowActions?: RowAction[]
}

const PAGE_SIZES = [10, 20, 50, 100]

export function selectedRows(selection: Selection, rows: Row[]): Row[] {
  // DataGrid 的 "all" 语义 = 当前页全选(spec 非目标:不做跨页全选)
  if (selection === 'all') return rows
  return rows.filter((r) => selection.has(r.id))
}

function defaultCell(col: GridColumnMeta, value: unknown): ReactNode {
  if (value == null || value === '') return <span className="text-muted">—</span>
  switch (col.type) {
    case 'boolean':
      return <Chip size="sm" color={value ? 'success' : 'default'}>{value ? '是' : '否'}</Chip>
    case 'datetime':
      return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
    case 'enum':
      return col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)
    default:
      return String(value)
  }
}

export function SynieDataGrid(props: SynieDataGridProps) {
  const { resource, exclude = [], overrides = {} } = props

  const meta = useGridMeta(resource)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sort, setSort] = useState<SortState | null>(null)
  const [filters, setFilters] = useState<FilterState>({})
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection>(new Set())

  const columns = useMemo(
    () => (meta.data?.columns ?? []).filter((c) => c.name !== 'id' && !exclude.includes(c.name)),
    [meta.data, exclude]
  )

  const filterLiteral = meta.data ? buildFilterLiteral(filters, search, meta.data.columns) : null
  const sortLiteral = toSortLiteral(sort)

  const rowsQuery = useQuery({
    queryKey: ['gridRows', resource, page, pageSize, sortLiteral, filterLiteral],
    enabled: !!meta.data,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query = buildRowQuery(resource, columns, {
        limit: pageSize,
        offset: (page - 1) * pageSize,
        sortLiteral,
        filterLiteral,
      })
      return gqlFetch<Record<string, { count: number; results: Row[] }>>(query).then((d) => d[resource])
    },
  })

  const rows = rowsQuery.data?.results ?? []
  const count = rowsQuery.data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / pageSize))

  const gridColumns: DataGridColumn<Row>[] = useMemo(
    () =>
      columns.map((col) => ({
        id: col.name,
        header: overrides[col.name]?.label ?? col.label,
        allowsSorting: col.sortable,
        width: overrides[col.name]?.width,
        cell: (row: Row) => overrides[col.name]?.render?.(row[col.name], row) ?? defaultCell(col, row[col.name]),
      })),
    [columns, overrides]
  )

  const sortDescriptor: DataGridSortDescriptor | undefined = sort
    ? { column: sort.column, direction: sort.direction }
    : undefined

  if (meta.isPending || (rowsQuery.isPending && !rowsQuery.data)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  if (meta.isError || rowsQuery.isError) {
    const err = (meta.error ?? rowsQuery.error) as Error
    return (
      <EmptyState size="md" className="h-64 justify-center">
        <EmptyState.Header>
          <EmptyState.Title>数据加载失败</EmptyState.Title>
          <EmptyState.Description>{err.message}</EmptyState.Description>
        </EmptyState.Header>
        <EmptyState.Content>
          <Button variant="secondary" onPress={() => (meta.isError ? meta.refetch() : rowsQuery.refetch())}>
            重试
          </Button>
        </EmptyState.Content>
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏:Task 5 加搜索/筛选,Task 6 加动作按钮 */}
      <DataGrid
        aria-label={`${resource} 数据表格`}
        data={rows}
        columns={gridColumns}
        getRowId={(r) => r.id}
        selectionMode="multiple"
        showSelectionCheckboxes
        selectedKeys={selection}
        onSelectionChange={setSelection}
        sortDescriptor={sortDescriptor}
        onSortChange={(d) => {
          setSort({ column: String(d.column), direction: d.direction })
          setPage(1)
        }}
        renderEmptyState={() => (
          <EmptyState size="sm" className="py-10">
            <EmptyState.Header>
              <EmptyState.Title>暂无数据</EmptyState.Title>
              <EmptyState.Description>没有符合条件的记录。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        )}
        contentClassName="min-w-[720px]"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted">共 {count} 条</span>
        <div className="flex items-center gap-3">
          <InlineSelect
            aria-label="每页条数"
            value={String(pageSize)}
            onChange={(v) => {
              if (v != null) {
                setPageSize(Number(v))
                setPage(1)
              }
            }}
          >
            <InlineSelect.Trigger>
              <InlineSelect.Value />
              <InlineSelect.Indicator />
            </InlineSelect.Trigger>
            <InlineSelect.Popover className="w-[120px]">
              <ListBox>
                {PAGE_SIZES.map((n) => (
                  <ListBox.Item key={n} id={String(n)} textValue={`${n} 条/页`}>
                    {n} 条/页
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </InlineSelect.Popover>
          </InlineSelect>
          <Pager page={page} totalPages={totalPages} onChange={setPage} />
        </div>
      </div>
    </div>
  )
}

/** >7 页时:首尾 + 当前±1 + 省略号 */
function pageNumbers(page: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const middle = [page - 1, page, page + 1].filter((p) => p > 1 && p < total)
  const out: (number | 'ellipsis')[] = [1]
  if (middle[0] !== undefined && middle[0] > 2) out.push('ellipsis')
  out.push(...middle)
  if (middle.length > 0 && middle[middle.length - 1] < total - 1) out.push('ellipsis')
  out.push(total)
  return out
}

function Pager({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  return (
    <Pagination size="sm">
      <Pagination.Content>
        <Pagination.Item>
          <Pagination.Previous isDisabled={page <= 1} onPress={() => onChange(page - 1)}>
            <Pagination.PreviousIcon />
          </Pagination.Previous>
        </Pagination.Item>
        {pageNumbers(page, totalPages).map((p, i) => (
          <Pagination.Item key={`${p}-${i}`}>
            {p === 'ellipsis' ? (
              <Pagination.Ellipsis />
            ) : (
              <Pagination.Link isActive={p === page} onPress={() => onChange(p)}>
                {p}
              </Pagination.Link>
            )}
          </Pagination.Item>
        ))}
        <Pagination.Item>
          <Pagination.Next isDisabled={page >= totalPages} onPress={() => onChange(page + 1)}>
            <Pagination.NextIcon />
          </Pagination.Next>
        </Pagination.Item>
      </Pagination.Content>
    </Pagination>
  )
}
