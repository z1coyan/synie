import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ActionBar, DataGrid, EmptyState, InlineSelect, type DataGridColumn, type DataGridSortDescriptor } from '@heroui-pro/react'
import { Button, Chip, CloseButton, Dropdown, Label, ListBox, Pagination, SearchField, Separator, Spinner, toast } from '@heroui/react'
import type { Selection } from 'react-aria-components'
import { isForbidden } from '~/lib/errors'
import { useMediaQuery } from '~/lib/use-media-query'
import { createResourceQueryCache } from '~/lib/resources/catalog'
import { resourceBindingFor } from '~/lib/resources/registry'
import type { ResourceTransport } from '~/lib/resources/types'
import { AttachmentImagesCell } from './attachment-images-cell'
import { cardFields } from './card-fields'
import { CardList, type CardSelection } from './card-list'
import { cellContent, imageFileId, imageFilename, type ColumnOverride, type GridImageOverride } from './cells'
import { CardFilterSheet, CardSortSheet } from './filter-sheet'
import { hasMoreRows, mergeLoadedRows } from './load-more'
import { visibleOnCard } from './mobile-actions'
import { RowActionsMenu } from './row-menu'
import { downloadCsv, fetchAllRows, toCsv } from './csv'
import { ColumnFilterButton, filterSummary } from './filter-popover'
import { cellText } from './format'
import { mergePick } from './pick'
import { useGridMeta } from './meta'
import { printRows } from './print'
import { nextSort } from './query'
import type { ActionContext, BulkAction, ColumnFilter, EnumChipColor, FilterState, GridColumnMeta, Row, RowAction, SortState } from './types'
import type { ResolvedAction } from './use-grid-actions'
import { FkLink } from '../synie-record-drawer/fk-preview'
import { FileThumb } from '../synie-preview/FileThumb'
import { SyniePreview, type SyniePreviewItem } from '../synie-preview/SyniePreview'
import { useDraft } from './use-debounced'
import { useGridActions } from './use-grid-actions'

// 单元格渲染与列 override 类型已迁入 cells.tsx(表格/卡片/编辑表三处共用);
// 此处 re-export 保持既有 import 路径(页面与 SynieEditableTable)不破
export { defaultCell } from './cells'
export type { ColumnOverride, GridImageOverride } from './cells'

export interface AttachmentImagesOptions {
  /** sys_attachment.owner_type 资源类型名，如 acc_vat_invoice。 */
  ownerType: string
  /** 限定槽位;缺省全部槽位 */
  category?: string
  /** 列头文案,默认「图片」 */
  label?: string
}

export interface ImportMenuItem {
  key: string
  label: string
  onAction: (ctx: ActionContext) => void
}

export interface TreeOptions {
  /** 父引用列名,默认 'parentId' */
  parentField?: string
  /** 判断有无子节点的列名(值 >0 出展开箭头),默认 'childrenCount' */
  hasChildrenField?: string
  /** 每层取数排序,如 { field: 'code', order: 'ASC' } */
  sort?: { field: string; order: 'ASC' | 'DESC' }
}

export interface SynieDataGridProps {
  /** 与后端 GridMeta 白名单同名,如 "sysRoles" */
  resource: string
  /**
   * @deprecated 生产调用只传 resource。仅保留给显式测试/本地 Adapter；
   * 缺省直接使用 ResourceBinding.reader。
   * Meta 始终从 Catalog 拉取，不经 client.meta。
   */
  client?: ResourceTransport
  /** 显示列及其顺序(有序白名单);缺省 = meta 全列。与 exclude 二选一即可 */
  columns?: string[]
  exclude?: string[]
  overrides?: Record<string, ColumnOverride>
  /** 覆盖 meta 下发的 capabilities 门控:资源复用他人权限码、meta capabilities 为空时
   *  页面显式声明可用动作(如 salOrderItems 复用 sales.order 权限码,条目视图声明 ['create','update']);
   *  仅驱动按钮显隐,服务端 policy 仍是权威校验 */
  capabilities?: string[]
  /** 传了就在行内菜单第一项显示「查看」(打开详情抽屉) */
  onView?: (row: Row) => void
  onCreate?: () => void
  /** 「新增」按钮文案覆盖(如固定动线的「新增承兑接收」) */
  createLabel?: string
  onEdit?: (row: Row) => void
  onImport?: (ctx: ActionContext) => void
  /** 提供时「导入」按钮渲染为下拉菜单(仍由 can('import') 门控),与 onImport 二选一 */
  importMenu?: ImportMenuItem[]
  /** 隐藏搜索框(抽屉内嵌短列表等场景);工具栏动作按钮不受影响 */
  hideSearch?: boolean
  onPrint?: (rows: Row[]) => void
  actionHandlers?: Record<string, (rows: Row[], ctx: ActionContext) => void>
  /** 按行显隐行内动作:key 为扩展动作 key、自定义 rowActions key 或内建 'edit'/'delete'(如仅草稿订单可删),返回 false 该行不显示 */
  actionVisible?: Record<string, (row: Row) => boolean>
  /** 内建/扩展动作的卡片模式显隐(如 { print: false } 行内打印不下手机、{ batch_print: true } 批量打印上手机) */
  actionMobile?: Record<string, boolean>
  bulkActions?: BulkAction[]
  rowActions?: RowAction[]
  /** 选择器模式:表格作为弹窗选择器主体,隐藏动作/批量条,选中受控且跨页累积 */
  pick?: 'single' | 'multiple'
  pickedRows?: Row[]
  onPickChange?: (rows: Row[]) => void
  /** 树形懒加载模式:按需逐层拉子节点,隐藏分页、禁用列排序;用户输入搜索/列筛选时自动退回平铺分页,清空恢复 */
  tree?: TreeOptions
  /** 恒定并进查询 filter 的条件(如 { companyId: { eq: id } }),不进列筛选 UI,平铺/树形都生效 */
  fixedFilter?: Record<string, unknown>
  /** fk join 追加取回的关系字段,按 relation 名配置(如 { category: ['code'] });供列 render override 展示 */
  joinFields?: Record<string, string[]>
  /**
   * 列以外还要取回的标量字段(不进表格展示,进 results 行数据)。
   * 选择器确认后要带 id 之外的业务键(如 materialId/unitId)时用。
   */
  extraFields?: string[]
  /** 初始排序(如流水页按交易时间倒序);仅作初值,用户点表头后照常接管 */
  defaultSort?: SortState
  /** 初始列筛选(如报表下钻带条件跳转);仅作初值,用户可照常改/清,变更预置条件需换 key 重挂 */
  defaultFilters?: FilterState
  /** 列筛选变更回调(如建单时按公司列筛唯一值预填公司);不控 filter 状态 */
  onFiltersChange?: (filters: FilterState) => void
  /** 本页汇总行:表格下方、分页上方渲染(如金额本页合计);rows 为当前页数据 */
  pageSummary?: (rows: Row[]) => ReactNode
  /** 附件图片列:行记录的图片附件(sys_attachment 多态挂接)以缩略图列呈现,
   *  点击全屏预览该行全部图片;与抽屉附件面板同 queryKey,面板上传后本列自动刷新 */
  attachmentImages?: AttachmentImagesOptions
  /** 内建/自定义动作成功变更数据、本表 refetch 时一并回调,供页面联动失效关联资源缓存 */
  onMutated?: () => void
}

const PAGE_SIZES = [10, 20, 50, 100]
const TREE_LEVEL_LIMIT = 200 // ponytail: 每层上限200,超了再做层内加载更多
// 移动断点与仓库统一约定一致(lg):<lg 时 grid 切卡片模式
const CARD_MODE_QUERY = '(max-width: 1023px)'

// 树形懒加载占位子行:DataGrid 只在 getChildren 返回非空数组时渲染 chevron(内部 hasChildItems =
// children.length > 0,返回 undefined/[] 都不出箭头),所以「有子但未加载」的节点先塞一个占位行,
// 展开后请求落地再替换成真实子行;占位行以 id 前缀识别,渲染为「加载中…」
const LOADING_ROW_PREFIX = '__treeLoading:'
const loadingRowFor = (parentId: string): Row => ({ id: `${LOADING_ROW_PREFIX}${parentId}` })
const isLoadingRow = (row: Row) => row.id.startsWith(LOADING_ROW_PREFIX)

// 模块级稳定默认值:默认参数若写成内联 []/{}, 不传 props 时每次渲染都是新引用,useMemo 永远失效
const EMPTY_EXCLUDE: string[] = []
const EMPTY_OVERRIDES: Record<string, ColumnOverride> = {}
const getRowId = (r: Row) => r.id

/** 搜索框草稿化:打字即时回显,停稳 300ms 才提交给父级,避免每键重渲染整表+发请求 */
function GridSearch({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useDraft(value, onCommit)
  return (
    <SearchField aria-label="搜索" value={draft} onChange={setDraft} className="w-64">
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input placeholder="搜索…" />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  )
}

export function selectedRows(selection: Selection, rows: Row[]): Row[] {
  // DataGrid 的 "all" 语义 = 当前页全选(spec 非目标:不做跨页全选)
  if (selection === 'all') return rows
  return rows.filter((r) => selection.has(r.id))
}

export function SynieDataGrid(props: SynieDataGridProps) {
  const { resource, exclude = EMPTY_EXCLUDE, overrides = EMPTY_OVERRIDES } = props
  const binding = resourceBindingFor(resource)
  // 显式 client 只服务测试/本地 Adapter 这一真实第二 Adapter；即使覆盖 Reader，
  // 缓存身份仍在本模块内构造，调用者不需要知道 key 中包含 Adapter id。
  const reader = props.client ?? binding.reader
  const queryCache = props.client
    ? createResourceQueryCache(resource, props.client.id)
    : binding.cache

  const meta = useGridMeta(resource, true)
  const pickMode = props.pick != null
  // 卡片模式:<lg 视口全资源生效;树形资源在卡片模式常驻平铺(treeActive 恒 false)
  const isMobile = useMediaQuery(CARD_MODE_QUERY)
  const cardMode = isMobile
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sort, setSort] = useState<SortState | null>(props.defaultSort ?? null)
  const [filters, setFilters] = useState<FilterState>(props.defaultFilters ?? {})
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection>(new Set())
  // 卡片模式筛选/排序底部弹层
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)
  const [sortSheetOpen, setSortSheetOpen] = useState(false)

  // 筛变通知页面(建单默认公司等);不把回调放进 deps 以免父组件未 memo 时循环
  useEffect(() => {
    props.onFiltersChange?.(filters)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  const columns = useMemo(() => {
    const base = (meta.data?.columns ?? []).filter((c) => c.name !== 'id' && !exclude.includes(c.name))
    if (!props.columns) return base
    const byName = new Map(base.map((c) => [c.name, c]))
    return props.columns.flatMap((n) => byName.get(n) ?? [])
  }, [meta.data, exclude, props.columns])

  // 卡片字段角色映射:override.mobileRole 汇成 roles 表交纯函数推导(卡片模式才消费)
  const cardRoles = useMemo(
    () => Object.fromEntries(Object.keys(overrides).map((k) => [k, overrides[k]?.mobileRole])),
    [overrides]
  )
  const cardLayout = useMemo(() => cardFields(columns, cardRoles), [columns, cardRoles])

  // 树形:用户一旦搜索/筛选就退回平铺分页(树与筛选语义冲突,避免命中子节点却父节点被滤掉的孤儿),清空恢复;
  // 卡片模式下树形常驻平铺(手机不做逐层展开,找节点靠搜索),桌面树形行为不变
  const treeMode = props.tree != null
  const userQuerying = search.trim() !== '' || Object.keys(filters).length > 0
  const treeActive = treeMode && !userQuerying && !cardMode
  const parentField = props.tree?.parentField ?? 'parentId'
  const hasChildrenField = props.tree?.hasChildrenField ?? 'childrenCount'
  const treeExtraFields = treeMode ? [parentField, hasChildrenField] : undefined
  const queryExtraFields = [...new Set([...(treeExtraFields ?? []), ...(props.extraFields ?? [])])]
  const queryExtraFieldsOrUndef = queryExtraFields.length > 0 ? queryExtraFields : undefined
  const fixedFilterKey = JSON.stringify(props.fixedFilter ?? null)

  const [expanded, setExpanded] = useState<Selection>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Map<string, Row[]>>(new Map())
  const [loadingParents, setLoadingParents] = useState<Set<string>>(new Set())

  // 图片列全屏预览:记住列与被点的 fileId;关闭只翻 open 让退场动画播完
  const [imagePreview, setImagePreview] = useState<{ col: string; fileId: string; open: boolean } | null>(null)
  // 附件图片列全屏预览:items 即被点行的全部图片附件
  const [attachmentPreview, setAttachmentPreview] = useState<{ items: SyniePreviewItem[]; open: boolean } | null>(null)

  // 切公司(fixedFilter 变)时已加载的子层缓存与展开态失效,重置;
  // 筛选进出(treeActive 翻转)不重置——清空筛选回树形时保留原展开状态;
  // 卡片模式下 fixedFilter 变更同属查询条件变更,页码重置回 1(累积整体替换)
  useEffect(() => {
    setExpanded(new Set())
    setChildrenByParent(new Map())
    setLoadingParents(new Set())
    setPage(1)
  }, [fixedFilterKey])

  const rowsQuery = useQuery({
    queryKey: queryCache.gridKey(
      treeActive,
      page,
      pageSize,
      search,
      JSON.stringify(sort),
      JSON.stringify(filters),
      fixedFilterKey,
      // extraFields 影响 results 形状,进 key 防与无 extra 的列表缓存串味
      queryExtraFieldsOrUndef?.slice().sort().join(',') ?? '',
    ),
    enabled: !!meta.data,
    placeholderData: keepPreviousData,
    queryFn: () =>
      reader.query({
        limit: treeActive ? TREE_LEVEL_LIMIT : pageSize,
        offset: treeActive ? 0 : (page - 1) * pageSize,
        search: treeActive ? undefined : search,
        sort: treeActive && props.tree?.sort
          ? { column: props.tree.sort.field, direction: props.tree.sort.order === 'ASC' ? 'ascending' : 'descending' }
          : sort,
        filter: treeActive
          ? { ...filters, [parentField]: { kind: 'fk', op: 'isNil', values: [], labels: [] } }
          : filters,
        fixedFilter: props.fixedFilter,
        extraFields: queryExtraFieldsOrUndef,
        joinFields: props.joinFields,
      }),
  })

  const rows = rowsQuery.data?.results ?? []
  const count = rowsQuery.data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / pageSize))

  // 卡片模式「加载更多」:page 语义=已加载页数,数据按页累积;
  // 查询条件(搜索/筛选/排序/fixedFilter)变更时各处理器已 setPage(1),第 1 页抵达即整体替换
  const [loadedRows, setLoadedRows] = useState<Row[]>([])
  useEffect(() => {
    if (!cardMode || !rowsQuery.data) return
    setLoadedRows((prev) => mergeLoadedRows(prev, rowsQuery.data.results, page))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardMode, rowsQuery.data])
  // 桌面→卡片切换时页码可能停在 N>1,重置回第 1 页从头累积(搜索/筛选/排序状态保留)
  useEffect(() => {
    if (cardMode) setPage(1)
  }, [cardMode])
  // 追加页失败:保留已加载卡片、toast 报错,加载更多按钮可重试(非幂等读操作给反馈)
  useEffect(() => {
    if (cardMode && rowsQuery.isError && loadedRows.length > 0) {
      toast.danger('加载更多失败', { description: (rowsQuery.error as Error | null)?.message })
    }
  }, [cardMode, rowsQuery.isError, rowsQuery.error, loadedRows.length])

  // 展开某节点时按 parentField eq 拉它的直接子层,结果进缓存;getChildren 从缓存读,折叠不清缓存
  const fetchChildren = (parentId: string) => {
    setLoadingParents((prev) => new Set(prev).add(parentId))
    reader
      .query({
        limit: TREE_LEVEL_LIMIT,
        offset: 0,
        sort: props.tree?.sort
          ? { column: props.tree.sort.field, direction: props.tree.sort.order === 'ASC' ? 'ascending' : 'descending' }
          : null,
        filter: { ...filters, [parentField]: { kind: 'fk', values: [parentId], labels: [] } },
        fixedFilter: props.fixedFilter,
        extraFields: queryExtraFieldsOrUndef,
        joinFields: props.joinFields,
      })
      .then((data) => setChildrenByParent((prev) => new Map(prev).set(parentId, data.results)))
      .catch((e) => toast.danger('加载下级失败', { description: (e as Error).message }))
      .finally(() =>
        setLoadingParents((prev) => {
          const next = new Set(prev)
          next.delete(parentId)
          return next
        }),
      )
  }

  // childrenCount>0 但未加载 → 返回占位行让 chevron 出现;展开时 onExpandedChange 落地真实子层
  const treeGetChildren = (row: Row): Row[] | undefined => {
    // 筛选回退平铺期间行不带子层(不出箭头);getChildren 本身保持传入,
    // 结构性 props 恒定才不会让 DataGrid 重建表头、打断筛选弹窗输入
    if (userQuerying) return undefined
    if (isLoadingRow(row)) return undefined
    if (Number(row[hasChildrenField] ?? 0) <= 0) return undefined
    const loaded = childrenByParent.get(row.id)
    if (loaded) return loaded.length > 0 ? loaded : undefined
    return [loadingRowFor(row.id)]
  }

  const handleExpandedChange = (keys: Selection) => {
    setExpanded(keys)
    if (keys === 'all') return
    for (const key of keys) {
      const id = String(key)
      if (!childrenByParent.has(id) && !loadingParents.has(id)) fetchChildren(id)
    }
  }

  // 批量删除清空最后一页后 count 缩小、totalPages 跟着变小,但 page 仍停在越界空页——收敛回最后一页
  useEffect(() => {
    if (rowsQuery.data && page > totalPages) setPage(totalPages)
  }, [rowsQuery.data, page, totalPages])

  const attachmentImages = props.attachmentImages
  // 筛选代理:override.filterField 将该列筛选改按同行另一字段(如物料列按 materialId 外键),
  // 展示/排序仍属列本身;目标字段取自 meta 全量列(可不在显示列白名单内),标签沿用列标签
  const filterTargetOf = (col: GridColumnMeta): GridColumnMeta | null => {
    const proxy = overrides[col.name]?.filterField
    if (proxy == null) return col.filterable ? col : null
    const target = meta.data?.columns.find((c) => c.name === proxy)
    return target?.filterable ? { ...target, label: overrides[col.name]?.label ?? col.label } : null
  }
  const gridColumns: DataGridColumn<Row>[] = useMemo(() => {
    const mapped: DataGridColumn<Row>[] = columns.map((col, i) => {
      const filterCol = filterTargetOf(col)
      return {
        id: col.name,
        align: overrides[col.name]?.align ?? (col.type === 'integer' || col.type === 'decimal' ? 'end' : undefined),
        // 筛选按钮绝对定位吸右,右侧留出内边距防止列名/排序箭头滑到按钮下面(右对齐列尤甚)
        headerClassName: filterCol ? 'pe-9' : undefined,
        // 函数式 header:DataGrid 自身按 allowsSorting 在文本后接排序箭头;筛选按钮脱离文档流吸在单元格右缘
        header: () => (
          <>
            {overrides[col.name]?.label ?? col.label}
            {filterCol && (
              <ColumnFilterButton
                column={filterCol}
                filter={filters[filterCol.name]}
                onChange={(f) => applyFilter(filterCol.name, f)}
              />
            )}
          </>
        ),
        // RAC Table 要求至少一列 isRowHeader(行的无障碍名称);缺失会在并发渲染中反复抛可恢复错误
        isRowHeader: i === 0,
        // 树形页面列排序无意义(单层懒加载),整表禁用排序入口。
        // 用恒定的 treeMode 而非 treeActive:筛选回退平铺时列定义不得翻转,否则表头重建打断筛选输入
        allowsSorting: treeMode ? false : col.sortable,
        width: overrides[col.name]?.width,
        cell: (row: Row) => {
          // 懒加载占位行只有 id:首列显示「加载中…」,其余列空
          if (isLoadingRow(row)) return i === 0 ? <span className="text-muted">加载中…</span> : null
          const text = cellContent(col, row, overrides[col.name])
          const img = overrides[col.name]?.image
          if (!img) return text
          const fileId = imageFileId(img, col.name, row)
          if (!fileId) return text
          const thumb = (
            <FileThumb
              fileId={fileId}
              alt={imageFilename(img, row)}
              onPress={() => setImagePreview({ col: col.name, fileId, open: true })}
            />
          )
          if (img !== true && img.keepText) {
            return (
              <span className="flex items-center gap-2">
                {thumb}
                {text}
              </span>
            )
          }
          return thumb
        },
      }
    })
    // 附件图片列:不来自 GridMeta 的虚拟列,不参与查询/排序/筛选/导出
    if (attachmentImages) {
      mapped.push({
        id: '__attachmentImages',
        header: () => <>{attachmentImages.label ?? '图片'}</>,
        allowsSorting: false,
        cell: (row: Row) =>
          isLoadingRow(row) ? null : (
            <AttachmentImagesCell
              ownerType={attachmentImages.ownerType}
              ownerId={row.id}
              category={attachmentImages.category}
              onPreview={(items) => setAttachmentPreview({ items, open: true })}
            />
          ),
      })
    }
    return mapped
  }, [columns, overrides, filters, treeMode, attachmentImages])

  // 取消排序必须传 null 而非 undefined:undefined 会让 DataGrid 退回非受控内部状态,残留首次点击存下的旧描述符
  const sortDescriptor = (sort ? { column: sort.column, direction: sort.direction } : null) as unknown as
    | DataGridSortDescriptor
    | undefined

  // 筛选变更处理器:列筛选弹层/Chips/筛选 Sheet 共用(变更即回第 1 页)
  const applyFilter = (name: string, f: ColumnFilter | null) => {
    setFilters((prev) => {
      const next = { ...prev }
      if (f === null) delete next[name]
      else next[name] = f
      return next
    })
    setPage(1)
  }
  const clearAllFilters = () => {
    setFilters({})
    setPage(1)
  }

  const [exporting, setExporting] = useState(false)

  // 工具栏动作按钮:桌面与卡片模式同一渲染(create 主色、export pending)
  const toolbarButton = (a: ResolvedAction) => (
    <Button
      key={a.key}
      size="sm"
      variant={a.key === 'create' ? 'primary' : 'secondary'}
      isPending={a.key === 'export' ? exporting : undefined}
      onPress={() => a.run([])}
    >
      {a.label}
    </Button>
  )

  const handleExport = async () => {
    setExporting(true)
    const id = toast(`正在导出…`, { isLoading: true, timeout: 0 })
    try {
      const all = await fetchAllRows(reader, {
        search,
        sort,
        filter: filters,
        fixedFilter: props.fixedFilter,
        extraFields: queryExtraFieldsOrUndef,
        joinFields: props.joinFields,
      })
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
    binding,
    capabilities: props.capabilities,
    refetch: () => {
      rowsQuery.refetch()
      props.onMutated?.()
    },
    clearSelection: () => setSelection(new Set()),
    onView: props.onView,
    onCreate: props.onCreate,
    createLabel: props.createLabel,
    onEdit: props.onEdit,
    // importMenu 模式下也要让工具栏出「导入」动作位(点击行为由下方 Dropdown 接管)
    onImport: props.importMenu ? () => {} : props.onImport,
    onExport: pickMode ? undefined : handleExport,
    onPrintRows: pickMode ? undefined : handlePrintRows,
    actionHandlers: props.actionHandlers,
    actionVisible: props.actionVisible,
    actionMobile: props.actionMobile,
    bulkActions: props.bulkActions,
    rowActions: props.rowActions,
  })

  // 行内动作列:仅当至少一行有可用动作时才拼接(避免空 Dropdown 占位列)。
  // 注意不能直接 push 进 memo 出来的 gridColumns——它在依赖不变时跨渲染复用同一数组引用,
  // 重复 push 会在每次重渲染后越叠越多;这里用 concat 生成新数组规避。
  // pick 选择器默认隐藏行菜单;若显式 onView / rowActions 则保留(如 BOM 选用弹窗可看详情)。
  const allowPickRowMenu =
    pickMode &&
    (!!props.onView || (props.rowActions != null && props.rowActions.length > 0))
  const hasRowMenu =
    (!pickMode || allowPickRowMenu) &&
    rows.some((r) => actions.rowMenuFor(r).length > 0)
  const columnsWithActions: DataGridColumn<Row>[] = hasRowMenu
    ? [
        ...gridColumns,
        {
          id: '__actions',
          header: '',
          pinned: 'end',
          width: 56,
          cell: (row: Row) => {
            if (isLoadingRow(row)) return null
            const items = actions.rowMenuFor(row)
            if (items.length === 0) return null
            return <RowActionsMenu items={items} row={row} />
          },
        },
      ]
    : gridColumns

  // 有 bulk 动作才开选择模式(否则勾选框无意义)
  const hasBulkActions = !pickMode && actions.bulkBarActions.length > 0

  // 卡片模式动作面:toolbar/批量默认隐藏(mobile:true 放上),行内默认保留(mobile:false 拿下)
  const cardToolbarActions = visibleOnCard(actions.toolbarActions, 'toolbar')
  const cardBulkActions = visibleOnCard(actions.bulkBarActions, 'bulk')
  const cardRowMenuFor = (row: Row) => visibleOnCard(actions.rowMenuFor(row), 'row')
  // 卡片模式批量勾选:有 mobile:true 的批量动作才开选择(语义同桌面 hasBulkActions)
  const cardSelectionEnabled = !pickMode && cardBulkActions.length > 0
  // 卡片模式下 picked 从已累积行解析(数据跨页追加)
  const picked = cardMode ? selectedRows(selection, loadedRows) : selectedRows(selection, rows)
  // 图片列预览等按「当前呈现的行」取数:卡片模式=累积行,桌面=当前页
  const displayRows = cardMode ? loadedRows : rows

  // pick 选择器的卡片点选:单选点击即换选/再点取消,多选勾选切换;跨追加批次累积走 mergePick
  const pickToggle = (row: Row) => {
    const current = props.pickedRows ?? []
    if (props.pick === 'single') {
      const isPicked = current.some((r) => r.id === row.id)
      props.onPickChange?.(mergePick(current, [row], new Set(isPicked ? [] : [row.id]), 'single'))
      return
    }
    const sel = new Set(current.map((r) => r.id))
    if (sel.has(row.id)) sel.delete(row.id)
    else sel.add(row.id)
    props.onPickChange?.(mergePick(current, loadedRows, sel, 'multiple'))
  }

  // 卡片模式批量勾选切换(非 pick):直接读写本地 selection
  const bulkToggle = (row: Row) =>
    setSelection((prev) => {
      const next = new Set(prev === 'all' ? loadedRows.map((r) => r.id) : prev)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      return next
    })

  const cardSelection: CardSelection | undefined = pickMode
    ? {
        mode: props.pick!,
        isSelected: (row) => (props.pickedRows ?? []).some((r) => r.id === row.id),
        onToggle: pickToggle,
      }
    : cardSelectionEnabled
      ? {
          mode: 'multiple',
          isSelected: (row) => selection !== 'all' && selection.has(row.id),
          onToggle: bulkToggle,
        }
      : undefined

  // 卡片模式工具栏:筛选/排序入口的可用列与生效计数;filterField 代理列以其目标字段计入
  const filterSheetColumns = columns.map((col) => filterTargetOf(col) ?? col)
  const hasFilterable = filterSheetColumns.some((c) => c.filterable)
  const hasSortable = columns.some((c) => c.sortable)
  const activeFilterCount = Object.keys(filters).length

  if (meta.isPending || (rowsQuery.isPending && !rowsQuery.data)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  // 卡片模式追加页失败不整屏报错:已加载卡片保留,错误走 toast,重试点「加载更多」
  if (meta.isError || (rowsQuery.isError && !(cardMode && loadedRows.length > 0))) {
    const err = (meta.error ?? rowsQuery.error) as Error
    // 无权限单独成态:醒目提示且不给重试(重试对权限问题无意义)
    if (isForbidden(err)) {
      return (
        <EmptyState size="md" className="h-64 justify-center">
          <EmptyState.Header>
            <EmptyState.Title className="text-danger">无权限访问</EmptyState.Title>
            <EmptyState.Description>当前账号没有查看这些数据的权限,请联系管理员分配。</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      )
    }
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
      {/* 工具栏:搜索 + 动作按钮;hideSearch 且无动作按钮时整行不渲染。
          卡片模式:动作按钮换为「筛选(带生效计数)/排序」入口,重操作回桌面 */}
      {(!props.hideSearch ||
        (!cardMode && actions.toolbarActions.length > 0) ||
        (cardMode && (hasFilterable || hasSortable))) && (
      <div className="flex flex-wrap items-center gap-3">
        {!props.hideSearch && (
          <GridSearch
            value={search}
            onCommit={(v) => {
              setSearch(v)
              setPage(1)
            }}
          />
        )}
        {!cardMode && (
        <div className="ml-auto flex items-center gap-2">
          {actions.toolbarActions.map((a) =>
            a.key === 'import' && props.importMenu ? (
              <Dropdown key={a.key}>
                <Button size="sm" variant="secondary">
                  {a.label}
                </Button>
                <Dropdown.Popover placement="bottom end">
                  <Dropdown.Menu
                    onAction={(key) =>
                      props.importMenu!
                        .find((m) => m.key === key)
                        ?.onAction({
                          refetch: () => {
                            rowsQuery.refetch()
                            props.onMutated?.()
                          },
                        })
                    }
                  >
                    {props.importMenu.map((m) => (
                      <Dropdown.Item key={m.key} id={m.key} textValue={m.label}>
                        <Label>{m.label}</Label>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            ) : (
              toolbarButton(a)
            )
          )}
        </div>
        )}
        {cardMode && (cardToolbarActions.length > 0 || hasFilterable || (hasSortable && !treeMode)) && (
          <div className="ml-auto flex items-center gap-2">
            {cardToolbarActions.map(toolbarButton)}
            {hasFilterable && (
              <Button size="sm" variant="secondary" onPress={() => setFilterSheetOpen(true)}>
                筛选{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
              </Button>
            )}
            {hasSortable && !treeMode && (
              <Button size="sm" variant="secondary" onPress={() => setSortSheetOpen(true)}>
                排序
              </Button>
            )}
          </div>
        )}
      </div>
      )}

      {/* 活跃筛选 Chips */}
      {Object.keys(filters).length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {Object.entries(filters).map(([name, f]) => {
            // filterField 代理筛选的键(如 materialId)可能不在显示列内,回退查 meta 全量列取标签
            const col = columns.find((c) => c.name === name) ?? meta.data?.columns.find((c) => c.name === name)
            return (
              <Chip key={name} size="sm" className="pr-1">
                <Chip.Label>{col ? `${col.label} ${filterSummary(col, f)}` : name}</Chip.Label>
                <CloseButton
                  aria-label={`清除 ${col?.label ?? name} 筛选`}
                  className="h-4 w-4 [&_svg]:size-3"
                  onPress={() => applyFilter(name, null)}
                />
              </Chip>
            )
          })}
          <Button
            size="sm"
            variant="ghost"
            onPress={clearAllFilters}
          >
            清除全部
          </Button>
        </div>
      )}

      {cardMode ? (
        <CardList
          rows={loadedRows}
          columns={columns}
          fields={cardLayout}
          overrides={overrides}
          onView={pickMode && !allowPickRowMenu ? undefined : props.onView}
          rowMenuFor={pickMode && !allowPickRowMenu ? undefined : cardRowMenuFor}
          selection={cardSelection}
          onImagePress={(col, row) => {
            const img = overrides[col]?.image
            if (!img) return
            const fileId = imageFileId(img, col, row)
            if (fileId) setImagePreview({ col, fileId, open: true })
          }}
          renderLeading={
            attachmentImages
              ? (row) => (
                  <AttachmentImagesCell
                    ownerType={attachmentImages.ownerType}
                    ownerId={row.id}
                    category={attachmentImages.category}
                    placeholder={null}
                    onPreview={(items) => setAttachmentPreview({ items, open: true })}
                  />
                )
              : undefined
          }
        />
      ) : (
      <DataGrid
        aria-label={`${resource} 数据表格`}
        data={rows}
        columns={columnsWithActions}
        getRowId={getRowId}
        /* 树形页面结构性 props 恒定(getChildren/expandedKeys 始终传入),筛选回退只换数据源;
           treeActive 翻转若连带翻转这些 props,DataGrid 会在树/平铺集合间整体重建并卸载表头筛选弹窗 */
        getChildren={treeMode ? treeGetChildren : undefined}
        expandedKeys={treeMode ? expanded : undefined}
        onExpandedChange={treeMode ? handleExpandedChange : undefined}
        selectionMode={pickMode ? props.pick : hasBulkActions ? 'multiple' : 'none'}
        showSelectionCheckboxes={pickMode ? props.pick === 'multiple' : hasBulkActions}
        selectedKeys={pickMode ? new Set((props.pickedRows ?? []).map((r) => r.id)) : selection}
        onSelectionChange={
          pickMode
            ? (sel: Selection) => props.onPickChange?.(mergePick(props.pickedRows ?? [], rows, sel, props.pick!))
            : setSelection
        }
        sortDescriptor={treeMode ? undefined : sortDescriptor}
        onSortChange={
          treeMode
            ? undefined
            : (d) => {
                setSort((prev) => nextSort(prev, String(d.column), d.direction))
                setPage(1)
              }
        }
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
      )}

      {props.pageSummary && <div className="px-4 py-2 text-sm text-muted">{props.pageSummary(rows)}</div>}

      {/* 卡片模式:加载更多取代数字分页(追加式浏览);加载完毕给终点提示 */}
      {cardMode && !treeActive && count > 0 && (
        <div className="flex justify-center">
          {hasMoreRows(loadedRows.length, count) ? (
            <Button
              variant="secondary"
              isPending={rowsQuery.isFetching && page > 1}
              // 追加失败重试当前页(refetch),而非页码+1 跳过失败页
              onPress={() => (rowsQuery.isError ? rowsQuery.refetch() : setPage((p) => p + 1))}
            >
              {rowsQuery.isError ? '加载失败，点击重试' : `加载更多（${loadedRows.length}/${count} 条）`}
            </Button>
          ) : (
            <span className="text-sm text-muted">已加载全部 {count} 条</span>
          )}
        </div>
      )}

      {/* 树形懒加载下总数/分页无意义,隐藏整条分页栏;卡片模式走上方加载更多 */}
      {!treeActive && !cardMode && (
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
      )}

      {/* 批量条:桌面=全部批量动作;卡片模式仅 mobile:true 动作(勾选位随之启用) */}
      <ActionBar
        isOpen={picked.length > 0 && (cardMode ? cardBulkActions.length > 0 : hasBulkActions)}
        aria-label="批量操作"
      >
        <ActionBar.Prefix>
          <Chip size="sm">{picked.length}</Chip>
        </ActionBar.Prefix>
        <Separator />
        <ActionBar.Content>
          {(cardMode ? cardBulkActions : actions.bulkBarActions).map((a) => (
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

      {/* 卡片模式筛选/排序底部弹层:与桌面列头筛选、表头排序落同一 filters/sort 状态 */}
      {cardMode && (
        <>
          <CardFilterSheet
            isOpen={filterSheetOpen}
            onOpenChange={setFilterSheetOpen}
            columns={filterSheetColumns}
            filters={filters}
            onFilterChange={applyFilter}
            onClearAll={clearAllFilters}
          />
          <CardSortSheet
            isOpen={sortSheetOpen}
            onOpenChange={setSortSheetOpen}
            columns={columns}
            sort={sort}
            onSortChange={(next) => {
              setSort(next)
              setPage(1)
            }}
          />
        </>
      )}

      {/* 图片列全屏预览:items 携当前页该列全部图片可循环切换 */}
      {imagePreview &&
        (() => {
          const img = overrides[imagePreview.col]?.image
          if (!img) return null
          const items = displayRows.flatMap((row) => {
            const fileId = imageFileId(img, imagePreview.col, row)
            return fileId ? [{ fileId, filename: imageFilename(img, row) }] : []
          })
          return (
            <SyniePreview
              items={items}
              isOpen={imagePreview.open}
              onOpenChange={(open) => {
                if (!open) setImagePreview((s) => (s ? { ...s, open: false } : s))
              }}
              initialIndex={Math.max(
                0,
                items.findIndex((it) => it.fileId === imagePreview.fileId)
              )}
            />
          )
        })()}

      {/* 附件图片列全屏预览:该行全部图片循环切换 */}
      {attachmentPreview && (
        <SyniePreview
          items={attachmentPreview.items}
          isOpen={attachmentPreview.open}
          onOpenChange={(open) => {
            if (!open) setAttachmentPreview((s) => (s ? { ...s, open: false } : s))
          }}
        />
      )}
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

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
