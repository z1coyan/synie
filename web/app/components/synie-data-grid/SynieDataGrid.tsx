import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ActionBar, DataGrid, EmptyState, InlineSelect, type DataGridColumn, type DataGridSortDescriptor } from '@heroui-pro/react'
import { Button, Chip, CloseButton, Dropdown, Label, ListBox, Pagination, SearchField, Separator, Spinner, toast } from '@heroui/react'
import type { Selection } from 'react-aria-components'
import { gqlFetch } from '~/lib/graphql'
import { downloadCsv, fetchAllRows, toCsv } from './csv'
import { ColumnFilterButton, filterSummary } from './filter-popover'
import { cellText } from './format'
import { useGridMeta } from './meta'
import { printRows } from './print'
import { buildFilterLiteral, buildRowQuery, toSortLiteral } from './query'
import type { ActionContext, BulkAction, FilterState, GridColumnMeta, Row, RowAction, SortState } from './types'
import { useGridActions } from './use-grid-actions'

export interface ColumnOverride {
  render?: (value: unknown, row: Row) => ReactNode
  label?: string
  width?: number
  /** 不传时数值列(integer/decimal)默认右对齐 */
  align?: 'start' | 'center' | 'end'
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

// 模块级稳定默认值:默认参数若写成内联 []/{}, 不传 props 时每次渲染都是新引用,useMemo 永远失效
const EMPTY_EXCLUDE: string[] = []
const EMPTY_OVERRIDES: Record<string, ColumnOverride> = {}
const getRowId = (r: Row) => r.id

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
  const { resource, exclude = EMPTY_EXCLUDE, overrides = EMPTY_OVERRIDES } = props

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

  // 搜索/筛选列用组件内已排除 id/exclude 的 columns,被 exclude 隐藏的列不应参与搜索
  const filterLiteral = meta.data ? buildFilterLiteral(filters, search, columns) : null
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

  // 批量删除清空最后一页后 count 缩小、totalPages 跟着变小,但 page 仍停在越界空页——收敛回最后一页
  useEffect(() => {
    if (rowsQuery.data && page > totalPages) setPage(totalPages)
  }, [rowsQuery.data, page, totalPages])

  const gridColumns: DataGridColumn<Row>[] = useMemo(
    () =>
      columns.map((col, i) => ({
        id: col.name,
        align: overrides[col.name]?.align ?? (col.type === 'integer' || col.type === 'decimal' ? 'end' : undefined),
        // 筛选按钮绝对定位吸右,右侧留出内边距防止列名/排序箭头滑到按钮下面(右对齐列尤甚)
        headerClassName: col.filterable ? 'pe-9' : undefined,
        // 函数式 header:DataGrid 自身按 allowsSorting 在文本后接排序箭头;筛选按钮脱离文档流吸在单元格右缘
        header: () => (
          <>
            {overrides[col.name]?.label ?? col.label}
            {col.filterable && (
              <ColumnFilterButton
                column={col}
                filter={filters[col.name]}
                onChange={(f) => {
                  setFilters((prev) => {
                    const next = { ...prev }
                    if (f === null) delete next[col.name]
                    else next[col.name] = f
                    return next
                  })
                  setPage(1)
                }}
              />
            )}
          </>
        ),
        // RAC Table 要求至少一列 isRowHeader(行的无障碍名称);缺失会在并发渲染中反复抛可恢复错误
        isRowHeader: i === 0,
        allowsSorting: col.sortable,
        width: overrides[col.name]?.width,
        cell: (row: Row) => overrides[col.name]?.render?.(row[col.name], row) ?? defaultCell(col, row[col.name]),
      })),
    [columns, overrides, filters]
  )

  const sortDescriptor: DataGridSortDescriptor | undefined = sort
    ? { column: sort.column, direction: sort.direction }
    : undefined

  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    const id = toast(`正在导出…`, { isLoading: true, timeout: 0 })
    try {
      const all = await fetchAllRows(resource, columns, filterLiteral, sortLiteral)
      // 传 cellText:CSV 单元格与表格/打印视图同一套格式化(是/否、本地化时间、enum label)
      downloadCsv(`${resource}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(columns, all, cellText))
      toast.close(id)
      toast.success(`已导出 ${all.length} 条`)
    } catch (e) {
      toast.close(id)
      toast.danger('导出失败', { description: (e as Error).message })
    } finally {
      setExporting(false)
    }
  }

  const handlePrintRows = (rowsToPrint: Row[]) => {
    if (props.onPrint) {
      props.onPrint(rowsToPrint)
      return
    }
    // 弹窗被浏览器拦截时必须有反馈(非幂等操作 Toast 守则)
    if (!printRows(columns, rowsToPrint, `${resource} 打印`)) {
      toast.danger('打印视图打开失败', { description: '请检查浏览器弹窗拦截设置' })
    }
  }

  const actions = useGridActions({
    meta: meta.data,
    refetch: () => rowsQuery.refetch(),
    clearSelection: () => setSelection(new Set()),
    onCreate: props.onCreate,
    onEdit: props.onEdit,
    onImport: props.onImport,
    onExport: handleExport,
    onPrintRows: handlePrintRows,
    actionHandlers: props.actionHandlers,
    bulkActions: props.bulkActions,
    rowActions: props.rowActions,
  })

  // 行内动作列:仅当至少一行有可用动作时才拼接(避免空 Dropdown 占位列)。
  // 注意不能直接 push 进 memo 出来的 gridColumns——它在依赖不变时跨渲染复用同一数组引用,
  // 重复 push 会在每次重渲染后越叠越多;这里用 concat 生成新数组规避。
  const hasRowMenu = rows.some((r) => actions.rowMenuFor(r).length > 0)
  const columnsWithActions: DataGridColumn<Row>[] = hasRowMenu
    ? [
        ...gridColumns,
        {
          id: '__actions',
          header: '',
          pinned: 'end',
          width: 56,
          cell: (row: Row) => {
            const items = actions.rowMenuFor(row)
            if (items.length === 0) return null
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
          },
        },
      ]
    : gridColumns

  // 有 bulk 动作才开选择模式(否则勾选框无意义)
  const hasBulkActions = actions.bulkBarActions.length > 0
  const picked = selectedRows(selection, rows)

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
      {/* 工具栏:搜索 + Task 6 动作按钮 */}
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          aria-label="搜索"
          value={search}
          onChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
          className="w-64"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="搜索…" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <div className="ml-auto flex items-center gap-2">
          {actions.toolbarActions.map((a) => (
            <Button
              key={a.key}
              size="sm"
              variant={a.key === 'create' ? 'primary' : 'secondary'}
              isPending={a.key === 'export' ? exporting : undefined}
              onPress={() => a.run([])}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>

      {/* 活跃筛选 Chips */}
      {Object.keys(filters).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(filters).map(([name, f]) => {
            const col = columns.find((c) => c.name === name)
            return (
              <Chip key={name} size="sm" className="pr-1">
                <Chip.Label>{col ? `${col.label} ${filterSummary(col, f)}` : name}</Chip.Label>
                <CloseButton
                  aria-label={`清除 ${col?.label ?? name} 筛选`}
                  className="h-4 w-4 [&_svg]:size-3"
                  onPress={() => {
                    setFilters((prev) => {
                      const next = { ...prev }
                      delete next[name]
                      return next
                    })
                    setPage(1)
                  }}
                />
              </Chip>
            )
          })}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              setFilters({})
              setPage(1)
            }}
          >
            清除全部
          </Button>
        </div>
      )}

      <DataGrid
        aria-label={`${resource} 数据表格`}
        data={rows}
        columns={columnsWithActions}
        getRowId={getRowId}
        selectionMode={hasBulkActions ? 'multiple' : 'none'}
        showSelectionCheckboxes={hasBulkActions}
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

      <ActionBar isOpen={picked.length > 0 && hasBulkActions} aria-label="批量操作">
        <ActionBar.Prefix>
          <Chip size="sm">{picked.length}</Chip>
        </ActionBar.Prefix>
        <Separator />
        <ActionBar.Content>
          {actions.bulkBarActions.map((a) => (
            <Button
              key={a.key}
              size="sm"
              variant={a.isDanger ? 'danger-soft' : 'ghost'}
              onPress={() => a.run(picked)}
            >
              <span className="action-bar__label">{a.label}</span>
            </Button>
          ))}
        </ActionBar.Content>
        <Separator />
        <ActionBar.Suffix>
          <Button isIconOnly size="sm" variant="ghost" aria-label="取消选择" onPress={() => setSelection(new Set())}>
            <XIcon />
          </Button>
        </ActionBar.Suffix>
      </ActionBar>

      {actions.confirmDialog}
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

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="8" cy="13" r="1.5" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
