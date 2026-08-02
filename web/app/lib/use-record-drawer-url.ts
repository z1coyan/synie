/**
 * 记录抽屉 URL 化 hook(slug: url-record-drawer)。
 *
 * 把页面上「useState<{ mode, row } | null> + 开/关抽屉」的样板换成 URL search 参数:
 *   ?record=<id>&mode=view|edit   查看/编辑既有记录(深链直达、刷新保持、前进后退可恢复)
 *   ?record=new                   新建态(mode 参数忽略,序列化时落掉)
 *   无 record 参数                抽屉关闭,行为与改造前一致
 *
 * 兼容约定(与 Grid 状态入 URL 线相同):
 * - 读:useSearch({ strict: false }) 松散读取,路由无需 validateSearch;
 * - 写:一律函数式更新 prev => ({ ...prev, ...patch }),保留未知参数(尤其 Grid 筛选参数),
 *   绝不整包替换;undefined 键在序列化时落掉即删除该参数(router-core encode 跳过 void 0)。
 * - 历史语义:open 压栈(后退键可关抽屉),setMode/close 就地 replace(不制造历史噪音)。
 *
 * 初始行加载:深链/刷新时页面没有现成行数据,hook 按 recordId 经
 * resourceBindingFor(resource) 的 reader 自查一行;查询键走 binding.cache.rowKey(recordId),
 * 与 SynieRecordDrawer 内部 rowId 自查同键(并发去重,不重复发请求)。id 白名单
 * (UUID_RE)非法按查无处理,不发请求(同组件既有约定)。
 *
 * 三态 UI:页面把 recordId 传给 SynieRecordDrawer 的 rowId(不传 row),加载中 /
 * 记录不存在 / 无权限(403)由组件内建 QueryState/EmptyState 呈现;hook 暴露的
 * row/rowPending/rowMissing/rowError 供需要行数据或自绘状态的页面使用。
 *
 * 可选 enabled=false:不读/不写 URL、不发单条查询(供共享 Provider 在非列表宿主页关闭 URL 同步)。
 */
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { UUID_RE } from '~/components/synie-data-grid/query'
import type { Row } from '~/components/synie-data-grid/types'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import { resourceBindingFor } from '~/lib/resources/registry'

/** 新建态在 URL 里的哨兵值:?record=new(mode 参数忽略) */
export const RECORD_DRAWER_NEW = 'new'

/** URL 派生的抽屉状态;recordId 为 null 表示新建态 */
export interface RecordDrawerUrlState {
  mode: DrawerMode
  recordId: string | null
}

/**
 * 从松散 search 对象解析抽屉状态(纯函数)。
 * - 无 record / 空串 → null(关闭)
 * - record=new → create(mode 参数忽略)
 * - record=<id> → view;仅 mode=edit 时 edit,其余值一律回落 view(非法值不产生 edit 深链)
 * - mode 参数单独存在(无 record)不构成抽屉状态
 */
export function parseRecordDrawerSearch(
  search: Record<string, unknown>,
): RecordDrawerUrlState | null {
  const record = search.record
  if (typeof record !== 'string' || record === '') return null
  if (record === RECORD_DRAWER_NEW) return { mode: 'create', recordId: null }
  return { mode: search.mode === 'edit' ? 'edit' : 'view', recordId: record }
}

/**
 * 打开抽屉的 search 补丁(纯函数):调用侧 prev => ({ ...prev, ...patch }) 并入。
 * create 态写 record=new 并以 undefined 落掉 mode 键;view/edit 写 record=<id>&mode。
 */
export function recordDrawerOpenPatch(
  state: RecordDrawerUrlState,
): Record<string, unknown> {
  return state.mode === 'create' || state.recordId == null
    ? { record: RECORD_DRAWER_NEW, mode: undefined }
    : { record: state.recordId, mode: state.mode }
}

/** 关闭抽屉的 search 补丁:两个键置 undefined,序列化时落掉即清参 */
export const RECORD_DRAWER_CLOSE_PATCH: Record<string, unknown> = {
  record: undefined,
  mode: undefined,
}

export interface UseRecordDrawerUrlOptions {
  /**
   * 是否同步 URL。默认 true。
   * 共享 Provider 在非列表宿主(如工单页内嵌 BOM 抽屉)传 false:不读/不写 search、不发单条查询。
   */
  enabled?: boolean
}

export interface UseRecordDrawerUrlResult {
  /** 当前抽屉状态(URL 派生);null 表示关闭 */
  drawer: RecordDrawerUrlState | null
  /** 初始行(create 态或 id 非法时为 null);与抽屉内部 rowId 自查同缓存键 */
  row: Row | null
  /** 初始行加载中(含等查询就绪阶段) */
  rowPending: boolean
  /** 记录不存在:id 非法或查过了但没有(未查完是 undefined,不算 missing) */
  rowMissing: boolean
  /** 初始行加载失败(403 等);页面一般交给 SynieRecordDrawer 的 QueryState 呈现 */
  rowError: Error | null
  /** 打开抽屉(压栈):create 忽略 recordId;view/edit 必须给记录 id */
  open: (mode: DrawerMode, recordId?: string | null) => void
  /** 切换模式(就地 replace),用于 view → edit */
  setMode: (mode: DrawerMode) => void
  /** 关闭抽屉(就地 replace 清参,保留未知参数) */
  close: () => void
}

/** recordId 缺失/非法时给禁用查询用的稳定键(内容无意义,查询永不启用) */
const DISABLED_RECORD_QUERY_KEY = ['recordDrawerUrl', 'noRecord'] as const

export function useRecordDrawerUrl(
  resource: string,
  options?: UseRecordDrawerUrlOptions,
): UseRecordDrawerUrlResult {
  const enabled = options?.enabled !== false
  const binding = resourceBindingFor(resource)
  // 松散读:不强制路由声明 validateSearch,与 Grid URL 线共存
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const drawer = enabled ? parseRecordDrawerSearch(search) : null
  const recordId = drawer?.recordId ?? null
  const validId = recordId != null && UUID_RE.test(recordId)

  // 初始行自查:查询键与 SynieRecordDrawer 的 rowId 路径同为 binding.cache.rowKey(id),
  // 同键并发去重——页面再传 rowId 给抽屉也不会多发请求
  const rowQuery = useQuery({
    queryKey: validId
      ? binding.cache.rowKey(recordId)
      : DISABLED_RECORD_QUERY_KEY,
    enabled: enabled && validId,
    queryFn: () => binding.reader.get(recordId!),
  })

  const open: UseRecordDrawerUrlResult['open'] = (mode, id = null) => {
    if (!enabled) return
    void navigate({
      to: '.',
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        ...recordDrawerOpenPatch({ mode, recordId: id }),
      })) as never,
    })
  }

  const setMode: UseRecordDrawerUrlResult['setMode'] = (mode) => {
    if (!enabled) return
    void navigate({
      to: '.',
      replace: true,
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        // create 态不写 mode 键;view/edit 写 mode(非法 create 由 parse 回落 view)
        mode: mode === 'create' ? undefined : mode,
      })) as never,
    })
  }

  const close: UseRecordDrawerUrlResult['close'] = () => {
    if (!enabled) return
    void navigate({
      to: '.',
      replace: true,
      search: ((prev: Record<string, unknown>) => ({
        ...prev,
        ...RECORD_DRAWER_CLOSE_PATCH,
      })) as never,
    })
  }

  return {
    drawer,
    row: rowQuery.data ?? null,
    rowPending: validId && rowQuery.isPending,
    rowMissing: recordId != null && (!validId || rowQuery.data === null),
    rowError: (rowQuery.error as Error | null) ?? null,
    open,
    setMode,
    close,
  }
}
