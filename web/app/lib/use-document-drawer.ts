/**
 * 单据抽屉骨架(slug: document-drawer-skeleton)。
 *
 * 收口 13 个单据抽屉各自复刻的同一块管道(见架构评审 2026-08-03 候选 1):
 *   - urlSync / 本地双态状态机(列表页 URL 寻址 vs 内嵌宿主纯本地)
 *   - URL 身份 → 整单草稿装载:开抽屉占号、异步回填前比对的竞态协议,
 *     深链/前进后退按 recordId 补拉,关抽屉作废在途请求
 *   - 装载失败 toast 与非法 id 守卫(文案默认从资源文档中文标签派生)
 *
 * 边界(只收管道,不收条目):条目状态、条目编辑 UI、科目联动、快照回填与
 * onSubmit 仍属各抽屉声明。hook 返回 draft,各抽屉用一个派生 effect 初始化
 * 自己的条目集合(多集合单据——发货装箱、委外三类行——天然支持)。
 * 派生 effect 的依赖必须是 [drawer.draft, drawer.generation]:create/关闭时
 * draft 引用不变(null→null),只有 generation 变化能让 effect 触发重置。
 *
 * 分层:DocumentDetailLoader 是纯状态机(无 React,bun:test 直测竞态);
 * useDocumentDrawer 只做 React 接线(URL 源/本地态二选一 + 订阅状态机)。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceBindingFor } from '~/lib/resources/registry'
import { toastError } from '~/lib/toast'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

/** 明细装载状态快照;generation 随每次 open/close 自增,供 key= 重挂载布防基线 */
export interface DocumentDetailState<TDraft> {
  draft: TDraft | null
  /** 编辑态提交闸门:create 无既有子树恒可提交;装载失败保持 false(暂态空集合不能表示删除) */
  detailLoaded: boolean
  generation: number
  /** 当前已装载(或装载中)的记录 id;null 表示无明细(create/关闭) */
  loadedId: string | null
}

export interface DocumentDetailLoaderDeps<TDraft> {
  /** 整单草稿装载:聚合草稿 Adapter 的 loadDraft,或多子表 Promise.all 组装 */
  loadDraft: (recordId: string) => Promise<TDraft>
  /** 装载失败回调(toast 由 hook 注入,状态机本身不碰 UI) */
  onLoadError: (error: unknown) => void
  /** 非法 id(空串/字面 'undefined')守卫回调;缺省静默重置 */
  onOpenError?: (recordId: string) => void
}

/**
 * 整单草稿装载状态机。语义对齐各抽屉现有手写实现:
 * - open(id) 总是重新装载(显式打开即重拉);open(null) 即 create,重置为可提交空态
 * - syncIdentity 只响应身份变化:同 id 去重(与 open 防双发),null 仅已装载时重置
 * - 竞态:每次装载占号(generation+1),回填前比对,过期响应丢弃;close 作废全部在途
 */
export class DocumentDetailLoader<TDraft> {
  private state: DocumentDetailState<TDraft> = {
    draft: null,
    detailLoaded: false,
    generation: 0,
    loadedId: null,
  }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: DocumentDetailLoaderDeps<TDraft>) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): DocumentDetailState<TDraft> => this.state

  private setState(next: DocumentDetailState<TDraft>): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  /** 打开抽屉:create/无 id 传 null(重置);view/edit 传记录 id(开始装载) */
  open(recordId: string | null): void {
    if (recordId == null) {
      this.reset()
      return
    }
    // 防前端把 String(undefined) 当成 id 发请求(Invalid filter value "undefined")
    if (recordId === '' || recordId === 'undefined') {
      this.reset()
      this.deps.onOpenError?.(recordId)
      return
    }
    this.beginLoad(recordId)
  }

  /** URL 身份同步(深链/前进后退):null 覆盖「关闭」与「新建」;同 id 去重 */
  syncIdentity(recordId: string | null): void {
    if (recordId == null) {
      if (this.state.loadedId != null) this.reset()
      return
    }
    if (this.state.loadedId !== recordId) this.beginLoad(recordId)
  }

  /** 关闭抽屉:作废在途请求并清空 */
  close(): void {
    this.reset()
  }

  private reset(): void {
    this.setState({
      draft: null,
      detailLoaded: true,
      generation: this.state.generation + 1,
      loadedId: null,
    })
  }

  private beginLoad(recordId: string): void {
    const generation = this.state.generation + 1
    this.setState({ draft: null, detailLoaded: false, generation, loadedId: recordId })
    void this.deps.loadDraft(recordId).then(
      (draft) => {
        if (this.state.generation !== generation) return
        this.setState({ ...this.state, draft, detailLoaded: true })
      },
      (error: unknown) => {
        if (this.state.generation !== generation) return
        // detailLoaded 保持 false:编辑态提交被 assertAggregateDraftReady 拦截
        this.setState({ ...this.state, draft: null })
        this.deps.onLoadError(error)
      },
    )
  }
}

export interface UseDocumentDrawerOptions<TDraft> {
  resource: string
  /** 列表 layout 传 true:开/关/模式走 ?record=&mode=;内嵌宿主(如工单页 BOM)保持 false 纯本地态 */
  urlSync?: boolean
  loadDraft: (recordId: string) => Promise<TDraft>
  /** 装载失败 toast 标题覆盖;默认「{资源文档 label}明细加载失败」 */
  loadErrorLabel?: string
  /** 非法 id 守卫 toast 标题覆盖;默认「无法打开{资源文档 label}」 */
  openErrorLabel?: string
}

export interface UseDocumentDrawerResult<TDraft> {
  isOpen: boolean
  mode: DrawerMode
  rowId: string | undefined
  /** 当前记录行(urlSync 为 URL 自查行,本地态为 open 传入行);create/关闭为 null */
  row: Row | null
  draft: TDraft | null
  detailLoaded: boolean
  generation: number
  /** 打开抽屉:create 传 (mode='create', null);view/edit 传带 id 的行(只需 id 字段) */
  open: (mode: DrawerMode, row: { id?: unknown } | null) => void
  close: () => void
  setMode: (mode: DrawerMode) => void
}

export function useDocumentDrawer<TDraft>(
  options: UseDocumentDrawerOptions<TDraft>,
): UseDocumentDrawerResult<TDraft> {
  const { resource, loadDraft, loadErrorLabel, openErrorLabel } = options
  const urlSync = options.urlSync === true
  const url = useRecordDrawerUrl(resource, { enabled: urlSync })
  const [localDrawer, setLocalDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(
    null,
  )

  // 资源文档中文标签:to toast 文案派生(通常页面已加载文档,命中缓存)
  const docLabelRef = useRef<string>(resource)
  useEffect(() => {
    let cancelled = false
    void resourceBindingFor(resource)
      .loadDocument()
      .then((doc) => {
        if (!cancelled && typeof doc.label === 'string' && doc.label !== '') {
          docLabelRef.current = doc.label
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [resource])

  // 状态机实例随组件存活;deps 每渲染刷新,回调永不陈旧
  const depsRef = useRef({ loadDraft, loadErrorLabel, openErrorLabel })
  depsRef.current = { loadDraft, loadErrorLabel, openErrorLabel }
  const loaderRef = useRef<DocumentDetailLoader<TDraft> | null>(null)
  if (loaderRef.current === null) {
    loaderRef.current = new DocumentDetailLoader<TDraft>({
      loadDraft: (id) => depsRef.current.loadDraft(id),
      onLoadError: (e) => {
        const label = depsRef.current.loadErrorLabel ?? `${docLabelRef.current}明细加载失败`
        toastError(label)(e)
      },
      onOpenError: () => {
        const label = depsRef.current.openErrorLabel ?? `无法打开${docLabelRef.current}`
        toastError(label)(new Error('缺少记录 id'))
      },
    })
  }
  const loader = loaderRef.current
  // SSR 必须提供 getServerSnapshot（否则每次渲染报 Missing getServerSnapshot 并回退客户端渲染）
  const detail = useSyncExternalStore(
    loader.subscribe,
    loader.getState,
    loader.getState,
  )

  // 深链/前进后退:URL 驱动打开时 open 未走,按 recordId 补拉/重置
  const urlRecordId = url.drawer?.recordId ?? null
  const urlMode = url.drawer?.mode
  useEffect(() => {
    if (!urlSync) return
    loader.syncIdentity(url.drawer == null || urlMode === 'create' ? null : urlRecordId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 URL 抽屉身份变化时响应
  }, [urlSync, urlRecordId, urlMode, url.drawer == null])

  const open = (mode: DrawerMode, row: { id?: unknown } | null): void => {
    const recordId = mode === 'create' || row?.id == null ? null : String(row.id)
    if (urlSync) url.open(mode, recordId)
    else setLocalDrawer({ mode, row: row as Row | null })
    loader.open(recordId)
  }

  const close = (): void => {
    if (urlSync) url.close()
    else setLocalDrawer(null)
    loader.close()
  }

  const setMode = (mode: DrawerMode): void => {
    if (urlSync) url.setMode(mode)
    else setLocalDrawer((d) => (d ? { ...d, mode } : d))
  }

  return {
    isOpen: urlSync ? url.drawer !== null : localDrawer !== null,
    mode: urlSync ? (url.drawer?.mode ?? 'view') : (localDrawer?.mode ?? 'view'),
    rowId: urlSync
      ? (url.drawer?.recordId ?? undefined)
      : localDrawer?.row?.id != null
        ? String(localDrawer.row.id)
        : undefined,
    row: urlSync ? url.row : (localDrawer?.row ?? null),
    draft: detail.draft,
    detailLoaded: detail.detailLoaded,
    generation: detail.generation,
    open,
    close,
    setMode,
  }
}
