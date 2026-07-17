import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ActionBar, DataGrid, EmptyState, InlineSelect, type DataGridColumn, type DataGridSortDescriptor } from '@heroui-pro/react'
import { Button, Chip, CloseButton, Dropdown, Label, ListBox, Pagination, Popover, SearchField, Separator, Spinner, toast } from '@heroui/react'
import type { Selection } from 'react-aria-components'
import { gqlFetch, isForbidden } from '~/lib/graphql'
import { downloadCsv, fetchAllRows, toCsv } from './csv'
import { ColumnFilterButton, filterSummary } from './filter-popover'
import { cellText } from './format'
import { mergePick } from './pick'
import { useGridMeta } from './meta'
import { printRows } from './print'
import { buildFilterLiteral, buildRowQuery, mergeFilterLiterals, nextSort, toGqlLiteral, toSortField, toSortLiteral } from './query'
import type { ActionContext, BulkAction, EnumChipColor, FilterState, GridColumnMeta, Row, RowAction, SortState } from './types'
import { FkLink } from '../synie-record-drawer/fk-preview'
import { attachmentListKey, fetchAttachmentList } from '../synie-attachment-panel/attachments'
import { FileThumb } from '../synie-preview/FileThumb'
import { SyniePreview, type SyniePreviewItem } from '../synie-preview/SyniePreview'
import { useDraft } from './use-debounced'
import { useGridActions } from './use-grid-actions'

export interface GridImageOverride {
  /** 解析该行的 sys_file id;返回空值回退默认单元格渲染(非图片行)。缺省:列值即 file id */
  fileId?: (row: Row) => string | null | undefined
  /** 预览/下载用文件名;缺省取行上 filename 字段(字符串时) */
  filename?: (row: Row) => string | null | undefined
  /** 缩略图旁保留默认文本渲染(文件名列等);纯 file id 列默认只显示缩略图 */
  keepText?: boolean
}

export interface ColumnOverride {
  render?: (value: unknown, row: Row) => ReactNode
  label?: string
  /** Pro DataGrid 是 auto 布局,th 定宽不生效;此值实际作为文本列 ClampCell 的内容上限(px),
   *  内容收窄列宽即跟着收窄。数值/enum/fk 列暂不受它约束 */
  width?: number
  /** 不传时数值列(integer/decimal)默认右对齐 */
  align?: 'start' | 'center' | 'end'
  /** enum 列胶囊配色,按枚举值(大写 token)映射;未配的值用 default 灰 */
  enumColors?: Record<string, EnumChipColor>
  /** 图片列:单元格渲染缩略图,点击全屏预览(SyniePreview),同列图片循环切换;true 即列值为 sys_file id */
  image?: true | GridImageOverride
}

/** 图片列取 file id/文件名:image 为 true 走缺省约定,对象形态可逐行定制 */
function imageFileId(img: true | GridImageOverride, colName: string, row: Row): string | null {
  const raw = img !== true && img.fileId ? img.fileId(row) : row[colName]
  return raw == null || raw === '' ? null : String(raw)
}

function imageFilename(img: true | GridImageOverride, row: Row): string | undefined {
  const name = img !== true && img.filename ? img.filename(row) : typeof row.filename === 'string' ? row.filename : null
  return name ?? undefined
}

export interface AttachmentImagesOptions {
  /** sys_attachment.owner_type(graphql type 名,如 acc_vat_invoice) */
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
  /** 按行显隐行内动作:key 为扩展动作 key 或内建 'edit'/'delete'(如仅草稿订单可删),返回 false 该行不显示 */
  actionVisible?: Record<string, (row: Row) => boolean>
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
  /** 初始排序(如流水页按交易时间倒序);仅作初值,用户点表头后照常接管 */
  defaultSort?: SortState
  /** 初始列筛选(如报表下钻带条件跳转);仅作初值,用户可照常改/清,变更预置条件需换 key 重挂 */
  defaultFilters?: FilterState
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

/** 超宽文本单元格:截断收起,溢出时点击弹 Popover 看全文;未溢出就是普通文本。
 * maxWidth 覆盖默认 320px 上限(Pro DataGrid auto 布局下列宽随内容,收内容即收列宽) */
function ClampCell({ text, maxWidth }: { text: string; maxWidth?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setOverflow(el.scrollWidth > el.clientWidth)
  }, [text])
  const clamp = `block truncate text-start${maxWidth == null ? ' max-w-80' : ''}`
  const style = maxWidth == null ? undefined : { maxWidth }
  if (!overflow) {
    return (
      <span ref={ref} className={clamp} style={style}>
        {text}
      </span>
    )
  }
  return (
    <Popover>
      <Popover.Trigger aria-label="查看完整内容" className={`${clamp} cursor-pointer`} style={style}>
        <span ref={ref} className={clamp} style={style}>
          {text}
        </span>
      </Popover.Trigger>
      <Popover.Content className="max-w-96">
        <Popover.Dialog>
          <p className="whitespace-pre-wrap break-words text-[13px]">{text}</p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  )
}

/** 默认单元格渲染(SynieEditableTable 复用,保持两处表格视觉一致);clampWidth 收窄文本列内容上限 */
export function defaultCell(
  col: GridColumnMeta,
  value: unknown,
  row: Row,
  enumColors?: Record<string, EnumChipColor>,
  clampWidth?: number
): ReactNode {
  // fk 列:link 点开速览抽屉(无 join 时组件内按 id 反查标签);CSV/打印仍走 cellText 纯文本
  if (col.type === 'fk' && col.ref) {
    return <FkLink col={col} row={row} />
  }
  if (value == null || value === '') return <span className="text-muted">—</span>
  switch (col.type) {
    case 'boolean':
      return <Chip size="sm" color={value ? 'success' : 'default'}>{value ? '是' : '否'}</Chip>
    case 'datetime':
      // 日期短且已全表 nowrap,不进 ClampCell,永不截断
      return new Date(String(value)).toLocaleString('zh-CN', { hour12: false })
    case 'integer':
    case 'decimal':
      // 数值短,不进 ClampCell:其 block+text-start 会盖掉 td 因 align:'end' 继承的右对齐
      return String(value)
    case 'enum':
      // enum 默认胶囊展示;配色经 override.enumColors 按值定制,未配的值灰胶囊
      return (
        <Chip size="sm" className="whitespace-nowrap" color={enumColors?.[String(value)] ?? 'default'}>
          {col.enumOptions?.find((o) => o.value === value)?.label ?? String(value)}
        </Chip>
      )
    default:
      return <ClampCell text={String(value)} maxWidth={clampWidth} />
  }
}

export function SynieDataGrid(props: SynieDataGridProps) {
  const { resource, exclude = EMPTY_EXCLUDE, overrides = EMPTY_OVERRIDES } = props

  const meta = useGridMeta(resource)
  const pickMode = props.pick != null
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sort, setSort] = useState<SortState | null>(props.defaultSort ?? null)
  const [filters, setFilters] = useState<FilterState>(props.defaultFilters ?? {})
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState<Selection>(new Set())

  const columns = useMemo(() => {
    const base = (meta.data?.columns ?? []).filter((c) => c.name !== 'id' && !exclude.includes(c.name))
    if (!props.columns) return base
    const byName = new Map(base.map((c) => [c.name, c]))
    return props.columns.flatMap((n) => byName.get(n) ?? [])
  }, [meta.data, exclude, props.columns])

  // 树形:用户一旦搜索/筛选就退回平铺分页(树与筛选语义冲突,避免命中子节点却父节点被滤掉的孤儿),清空恢复
  const treeMode = props.tree != null
  const userQuerying = search.trim() !== '' || Object.keys(filters).length > 0
  const treeActive = treeMode && !userQuerying
  const parentField = props.tree?.parentField ?? 'parentId'
  const hasChildrenField = props.tree?.hasChildrenField ?? 'childrenCount'
  const treeSortLiteral = props.tree?.sort
    ? `[{field: ${toSortField(props.tree.sort.field)}, order: ${props.tree.sort.order}}]`
    : null
  const treeExtraFields = treeMode ? [parentField, hasChildrenField] : undefined

  const [expanded, setExpanded] = useState<Selection>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Map<string, Row[]>>(new Map())
  const [loadingParents, setLoadingParents] = useState<Set<string>>(new Set())

  // 图片列全屏预览:记住列与被点的 fileId;关闭只翻 open 让退场动画播完
  const [imagePreview, setImagePreview] = useState<{ col: string; fileId: string; open: boolean } | null>(null)
  // 附件图片列全屏预览:items 即被点行的全部图片附件
  const [attachmentPreview, setAttachmentPreview] = useState<{ items: SyniePreviewItem[]; open: boolean } | null>(null)

  // 搜索/筛选列用组件内已排除 id/exclude 的 columns,被 exclude 隐藏的列不应参与搜索
  // 防抖在输入源头(useDraft:搜索框/筛选草稿),这里拿到的已是停稳值,离散操作(勾选/日期/清除)即时生效
  const userFilterLiteral = meta.data ? buildFilterLiteral(filters, search, columns) : null
  // fixedFilter 是组件受信条件(如公司过滤),平铺/树形都恒定并入,不进列筛选 UI
  const fixedFilterLiteral = props.fixedFilter ? toGqlLiteral(props.fixedFilter) : null
  const sortLiteral = toSortLiteral(sort)

  // 树形激活:只查根层(parentField isNil)、一次取满一层、按 tree.sort 排;否则常规分页
  const effectiveFilterLiteral = treeActive
    ? mergeFilterLiterals([`{${parentField}: {isNil: true}}`, fixedFilterLiteral])
    : mergeFilterLiterals([userFilterLiteral, fixedFilterLiteral])
  const effectiveSortLiteral = treeActive ? treeSortLiteral : sortLiteral

  // 切公司(fixedFilter 变)时已加载的子层缓存与展开态失效,重置;
  // 筛选进出(treeActive 翻转)不重置——清空筛选回树形时保留原展开状态
  useEffect(() => {
    setExpanded(new Set())
    setChildrenByParent(new Map())
    setLoadingParents(new Set())
  }, [fixedFilterLiteral])

  const rowsQuery = useQuery({
    queryKey: ['gridRows', resource, treeActive, page, pageSize, effectiveSortLiteral, effectiveFilterLiteral],
    enabled: !!meta.data,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query = buildRowQuery(resource, columns, {
        limit: treeActive ? TREE_LEVEL_LIMIT : pageSize,
        offset: treeActive ? 0 : (page - 1) * pageSize,
        sortLiteral: effectiveSortLiteral,
        filterLiteral: effectiveFilterLiteral,
        extraFields: treeExtraFields,
        joinFields: props.joinFields,
      })
      return gqlFetch<Record<string, { count: number; results: Row[] }>>(query).then((d) => d[resource])
    },
  })

  const rows = rowsQuery.data?.results ?? []
  const count = rowsQuery.data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / pageSize))

  // 展开某节点时按 parentField eq 拉它的直接子层,结果进缓存;getChildren 从缓存读,折叠不清缓存
  const fetchChildren = (parentId: string) => {
    setLoadingParents((prev) => new Set(prev).add(parentId))
    const childFilterLiteral = mergeFilterLiterals([
      `{${parentField}: {eq: ${JSON.stringify(parentId)}}}`,
      fixedFilterLiteral,
    ])
    const query = buildRowQuery(resource, columns, {
      limit: TREE_LEVEL_LIMIT,
      offset: 0,
      sortLiteral: treeSortLiteral,
      filterLiteral: childFilterLiteral,
      extraFields: treeExtraFields,
      joinFields: props.joinFields,
    })
    gqlFetch<Record<string, { count: number; results: Row[] }>>(query)
      .then((d) => setChildrenByParent((prev) => new Map(prev).set(parentId, d[resource].results)))
      .catch((e) => toast.danger('加载下级失败', { description: (e as Error).message }))
      .finally(() =>
        setLoadingParents((prev) => {
          const next = new Set(prev)
          next.delete(parentId)
          return next
        })
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
  const gridColumns: DataGridColumn<Row>[] = useMemo(() => {
    const mapped: DataGridColumn<Row>[] = columns.map((col, i) => ({
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
        // 树形页面列排序无意义(单层懒加载),整表禁用排序入口。
        // 用恒定的 treeMode 而非 treeActive:筛选回退平铺时列定义不得翻转,否则表头重建打断筛选输入
        allowsSorting: treeMode ? false : col.sortable,
        width: overrides[col.name]?.width,
        cell: (row: Row) => {
          // 懒加载占位行只有 id:首列显示「加载中…」,其余列空
          if (isLoadingRow(row)) return i === 0 ? <span className="text-muted">加载中…</span> : null
          const text =
            overrides[col.name]?.render?.(row[col.name], row) ??
            defaultCell(col, row[col.name], row, overrides[col.name]?.enumColors, overrides[col.name]?.width)
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
      }))
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

  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    const id = toast(`正在导出…`, { isLoading: true, timeout: 0 })
    try {
      const all = await fetchAllRows(resource, columns, effectiveFilterLiteral, effectiveSortLiteral)
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
    bulkActions: props.bulkActions,
    rowActions: props.rowActions,
  })

  // 行内动作列:仅当至少一行有可用动作时才拼接(避免空 Dropdown 占位列)。
  // 注意不能直接 push 进 memo 出来的 gridColumns——它在依赖不变时跨渲染复用同一数组引用,
  // 重复 push 会在每次重渲染后越叠越多;这里用 concat 生成新数组规避。
  const hasRowMenu = !pickMode && rows.some((r) => actions.rowMenuFor(r).length > 0)
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
  const hasBulkActions = !pickMode && actions.bulkBarActions.length > 0
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
      {/* 工具栏:搜索 + Task 6 动作按钮;hideSearch 且无动作按钮时整行不渲染 */}
      {(!props.hideSearch || actions.toolbarActions.length > 0) && (
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
          )}
        </div>
      </div>
      )}

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

      {props.pageSummary && <div className="px-4 py-2 text-sm text-muted">{props.pageSummary(rows)}</div>}

      {/* 树形懒加载下总数/分页无意义,隐藏整条分页栏 */}
      {!treeActive && (
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

      {/* 图片列全屏预览:items 携当前页该列全部图片可循环切换 */}
      {imagePreview &&
        (() => {
          const img = overrides[imagePreview.col]?.image
          if (!img) return null
          const items = rows.flatMap((row) => {
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

/** 附件图片列单元格:行自查图片附件(与附件面板同 queryKey,30s 内重挂不重取),
 *  首图缩略图 + 超出计数,点击预览该行全部图片 */
function AttachmentImagesCell({
  ownerType,
  ownerId,
  category,
  onPreview,
}: {
  ownerType: string
  ownerId: string
  category?: string
  onPreview: (items: SyniePreviewItem[]) => void
}) {
  const list = useQuery({
    queryKey: attachmentListKey(ownerType, ownerId, category),
    staleTime: 30_000,
    queryFn: () => fetchAttachmentList(ownerType, ownerId, category),
  })
  const images = (list.data ?? []).filter((r) => r.file.contentType?.startsWith('image/'))
  if (images.length === 0) return <span className="text-muted">—</span>
  return (
    <span className="flex items-center gap-1.5">
      <FileThumb
        fileId={images[0].file.id}
        alt={images[0].file.filename}
        onPress={() => onPreview(images.map((r) => ({ fileId: r.file.id, filename: r.file.filename })))}
      />
      {images.length > 1 && <span className="text-xs text-muted">+{images.length - 1}</span>}
    </span>
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
