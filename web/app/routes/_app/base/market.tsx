import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ReferenceLine } from 'recharts'
import { parseDate, today, getLocalTimeZone } from '@internationalized/date'
import {
  Button,
  Card,
  Chip,
  DateField,
  DateRangePicker,
  RangeCalendar,
  Skeleton,
  Spinner,
  Tabs,
  toast,
} from '@heroui/react'
import {
  ChartTooltip,
  EmptyState,
  KPI,
  LineChart,
  Segment,
  TrendChip,
} from '@heroui-pro/react'
import { isForbidden } from '~/lib/errors'
import { currencyClient } from '~/lib/resources/currencies'
import {
  getMarketChartInstruments,
  getMarketPriceSeries,
  marketInstrumentClient,
  marketPricePointClient,
  refreshMarketPricePoints,
  type MarketChartInstrument,
  type MarketPriceSeries,
  type MarketPriceSeriesItem,
  type MarketRefreshResult,
  type MarketSeriesPriceKind,
} from '~/lib/resources/market'
import { getSystemSetting } from '~/lib/resources/settings'
import { unitClient } from '~/lib/resources/units'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { FilterState, Row } from '~/components/synie-data-grid/types'

type TabId = 'prices' | 'instruments'
type PriceKind = MarketSeriesPriceKind
type RangePreset = '7' | '30' | '90' | '365' | 'custom'
/** 对比模式:绝对价(限同币种同单位) | 涨跌幅(窗内首点=0%,任意口径可同图) */
type CompareMode = 'absolute' | 'percent'

interface MarketSearch {
  tab: TabId
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)

export const Route = createFileRoute('/_app/base/market')({
  validateSearch: (search: Record<string, unknown>): MarketSearch => ({
    tab: search.tab === 'instruments' ? 'instruments' : 'prices',
  }),
  component: MarketPage,
})

// ── Types ────────────────────────────────────────────────

type ChartInstrument = MarketChartInstrument
type SeriesItem = MarketPriceSeriesItem
type SeriesPayload = MarketPriceSeries

type ChartPrefs = {
  instrumentIds?: string[]
  priceKind?: PriceKind
  rangePreset?: RangePreset
  customFrom?: string
  customTo?: string
  compareMode?: CompareMode
}

// ── Constants ────────────────────────────────────────────

const STORAGE_KEY = 'synie.market.chart'
const MAX_SERIES = 6

const PRICE_KIND_LABEL: Record<PriceKind, string> = {
  settlement: '结算价',
  average: '均价',
  last: '最新价',
}

const RANGE_LABEL: Record<Exclude<RangePreset, 'custom'>, string> = {
  '7': '近 7 日',
  '30': '近 30 日',
  '90': '近 90 日',
  '365': '近 1 年',
}

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
]

const PRICE_COLUMNS = [
  'instrumentId',
  'observedAt',
  'price',
  'priceKind',
  'currencyId',
  'unitId',
  'source',
  'isVoided',
  'note',
]

const INSTRUMENT_COLUMNS = [
  'code',
  'name',
  'sourceType',
  'defaultPriceKind',
  'currencyId',
  'unitId',
  'active',
  'fetchEnabled',
  'externalLastCode',
  'externalProductGroup',
  'note',
]

const ACTION_VISIBLE = {
  void: (row: Row) => row.isVoided !== true,
} satisfies Record<string, (row: Row) => boolean>

// ── Helpers ──────────────────────────────────────────────

function loadPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as ChartPrefs
  } catch {
    return {}
  }
}

function savePrefs(prefs: ChartPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore quota */
  }
}

/** 默认勾选:启用品种中最大 (币种,单位) 组,上限 6 */
function defaultSelectedIds(instruments: ChartInstrument[]): string[] {
  if (instruments.length === 0) return []
  const groups = new Map<string, ChartInstrument[]>()
  for (const i of instruments) {
    const key = `${i.currencyId}|${i.unitId}`
    const list = groups.get(key) ?? []
    list.push(i)
    groups.set(key, list)
  }

  let best: ChartInstrument[] = []
  for (const g of groups.values()) {
    if (g.length > best.length) {
      best = g
    } else if (g.length === best.length && g.length > 0) {
      const a = [...best].sort((x, y) => x.code.localeCompare(y.code))[0]!.code
      const b = [...g].sort((x, y) => x.code.localeCompare(y.code))[0]!.code
      if (b < a) best = g
    }
  }

  return [...best]
    .sort((x, y) => x.code.localeCompare(y.code))
    .slice(0, MAX_SERIES)
    .map((i) => i.id)
}

function resolveSelectedIds(
  instruments: ChartInstrument[],
  stored: string[] | undefined,
  allowMixed = false,
): string[] {
  const byId = new Map(instruments.map((i) => [i.id, i]))
  if (stored && stored.length > 0) {
    const kept = stored.filter((id) => byId.has(id)).slice(0, MAX_SERIES)
    if (kept.length === 0) return defaultSelectedIds(instruments)
    // 涨跌幅模式无量纲,允许跨口径;绝对价模式仍须同币种同单位
    if (allowMixed) return kept
    const first = byId.get(kept[0]!)!
    const sameScale = kept.every((id) => {
      const i = byId.get(id)!
      return i.currencyId === first.currencyId && i.unitId === first.unitId
    })
    if (sameScale) return kept
  }
  return defaultSelectedIds(instruments)
}

function rangeBounds(
  preset: RangePreset,
  customFrom?: string,
  customTo?: string,
): { from: string; to: string } {
  if (preset === 'custom' && customFrom && customTo) {
    return {
      from: new Date(`${customFrom}T00:00:00`).toISOString(),
      to: new Date(`${customTo}T23:59:59.999`).toISOString(),
    }
  }
  const days = preset === 'custom' ? 30 : Number(preset)
  const to = new Date()
  const from = new Date(to)
  from.setDate(from.getDate() - days)
  return { from: from.toISOString(), to: to.toISOString() }
}

function formatRunAt(iso: string | null | undefined): string {
  if (!iso) return '尚未运行'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function summarizeRefresh(payload: MarketRefreshResult): string {
  const items = payload.items
  if (items.length === 0) return '没有可刷新的品种（请检查是否启用拉取）'
  const ok = items.filter((i) => i.status === 'ok').length
  const skipped = items.filter((i) => i.status === 'skipped').length
  const err = items.filter((i) => i.status === 'error')
  const parts = [`成功 ${ok}`, `跳过 ${skipped}`]
  if (err.length > 0) {
    parts.push(
      `失败 ${err.length}` +
        (err[0]?.message ? `（${err[0].code ?? ''} ${err[0].message}）` : ''),
    )
  }
  return parts.join('，')
}

function formatPrice(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function formatAxisTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}

// ── Page ─────────────────────────────────────────────────

function MarketPage() {
  const { tab } = Route.useSearch()
  const navigate = useNavigate({ from: '/base/market' })
  const queryClient = useQueryClient()
  const prefs = useMemo(() => loadPrefs(), [])

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectionReady, setSelectionReady] = useState(false)
  const [priceKind, setPriceKind] = useState<PriceKind>(prefs.priceKind ?? 'settlement')
  const [compareMode, setCompareMode] = useState<CompareMode>(prefs.compareMode ?? 'absolute')
  const [rangePreset, setRangePreset] = useState<RangePreset>(prefs.rangePreset ?? '30')
  const [customFrom, setCustomFrom] = useState(
    prefs.customFrom ?? today(getLocalTimeZone()).subtract({ days: 30 }).toString(),
  )
  const [customTo, setCustomTo] = useState(
    prefs.customTo ?? today(getLocalTimeZone()).toString(),
  )
  const [gridFilterKey, setGridFilterKey] = useState(0)
  const [priceFilters, setPriceFilters] = useState<FilterState>({})
  const [refreshing, setRefreshing] = useState(false)

  const [priceDrawer, setPriceDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(
    null,
  )
  const [instrumentDrawer, setInstrumentDrawer] = useState<{
    mode: DrawerMode
    row: Row | null
  } | null>(null)

  const priceMeta = useGridMeta('basMarketPricePoints', true, marketPricePointClient)
  const instrumentMeta = useGridMeta('basMarketInstruments', true, marketInstrumentClient)
  const canPriceRead = priceMeta.data != null
  const canInstrumentRead = instrumentMeta.data != null
  const canPriceCreate = (priceMeta.data?.capabilities ?? []).includes('create')
  const permissionsPending = priceMeta.isPending || instrumentMeta.isPending
  const permissionsError = [priceMeta.error, instrumentMeta.error].find(
    (error) => error != null && !isForbidden(error),
  )

  // 两个资源独立取 Meta，保留仅能查看其中一个资源的部分权限。
  useEffect(() => {
    if (permissionsPending) return
    if (tab === 'prices' && !canPriceRead && canInstrumentRead) {
      navigate({ search: { tab: 'instruments' }, replace: true })
    } else if (tab === 'instruments' && !canInstrumentRead && canPriceRead) {
      navigate({ search: { tab: 'prices' }, replace: true })
    }
  }, [permissionsPending, canPriceRead, canInstrumentRead, tab, navigate])

  const instrumentsQuery = useQuery({
    queryKey: ['marketChartInstruments'],
    enabled: canPriceRead,
    queryFn: async () => {
      try {
        return await getMarketChartInstruments()
      } catch (error) {
        if (isForbidden(error)) return [] as ChartInstrument[]
        throw error
      }
    },
    staleTime: 30_000,
  })

  // 初始化/刷新勾选
  useEffect(() => {
    const list = instrumentsQuery.data
    if (!list) return
    setSelectedIds((prev) => {
      if (!selectionReady) {
        return resolveSelectedIds(list, prefs.instrumentIds, compareMode === 'percent')
      }
      // 列表变更时剔除失效 id(绝对价模式保持同口径)
      return resolveSelectedIds(list, prev, compareMode === 'percent')
    })
    setSelectionReady(true)
  }, [instrumentsQuery.data, prefs.instrumentIds, selectionReady, compareMode])

  // 持久化图区状态
  useEffect(() => {
    if (!selectionReady) return
    savePrefs({
      instrumentIds: selectedIds,
      priceKind,
      rangePreset,
      customFrom,
      customTo,
      compareMode,
    })
  }, [selectedIds, priceKind, rangePreset, customFrom, customTo, compareMode, selectionReady])

  const bounds = useMemo(
    () => rangeBounds(rangePreset, customFrom, customTo),
    [rangePreset, customFrom, customTo],
  )

  const seriesQuery = useQuery({
    queryKey: ['marketPriceSeries', selectedIds, priceKind, bounds.from, bounds.to],
    enabled: canPriceRead && selectionReady && selectedIds.length > 0,
    // 切换价类/区间/品种时保留上一帧数据,避免 KPI 与图表闪烁
    placeholderData: keepPreviousData,
    queryFn: async () => {
      // 涨跌幅模式允许跨口径:按 (币种,单位) 分组分别请求(后端单组内强制同口径),前端合并;
      // 绝对价模式选择必然同组,单请求一发即可
      const groups = new Map<string, string[]>()
      for (const id of selectedIds) {
        const inst = byId.get(id)
        if (!inst) continue
        const key = compareMode === 'percent' ? `${inst.currencyId}|${inst.unitId}` : 'all'
        groups.set(key, [...(groups.get(key) ?? []), id])
      }
      const payloads = await Promise.all(
        [...groups.values()].map((instrumentIds) =>
          getMarketPriceSeries({
            instrumentIds,
            priceKind,
            from: bounds.from,
            to: bounds.to,
          }),
        ),
      )
      const order = new Map(selectedIds.map((id, idx) => [id, idx]))
      const series = payloads
        .flatMap((payload) => payload.series)
        .sort(
          (a, b) => (order.get(a.instrumentId) ?? 0) - (order.get(b.instrumentId) ?? 0),
        )
      return {
        priceKind,
        from: bounds.from,
        to: bounds.to,
        series,
      } satisfies SeriesPayload
    },
  })

  const statusQuery = useQuery({
    queryKey: ['sysSetting', 'marketFetchStatus'],
    enabled: canPriceRead,
    queryFn: async () => {
      try {
        return await getSystemSetting()
      } catch (e) {
        if (isForbidden(e)) return null
        throw e
      }
    },
    staleTime: 30_000,
  })

  const instruments = instrumentsQuery.data ?? []
  const byId = useMemo(() => new Map(instruments.map((i) => [i.id, i])), [instruments])

  const toggleInstrument = useCallback(
    (id: string) => {
      const inst = byId.get(id)
      if (!inst) return

      setSelectedIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id)

        if (prev.length >= MAX_SERIES) {
          toast.danger(`最多同时对比 ${MAX_SERIES} 个品种`)
          return prev
        }

        // 涨跌幅模式无量纲,允许跨口径;绝对价模式仍须同币种同单位
        if (compareMode === 'absolute' && prev.length > 0) {
          const first = byId.get(prev[0]!)
          if (
            first &&
            (first.currencyId !== inst.currencyId || first.unitId !== inst.unitId)
          ) {
            toast.danger('绝对价对比须同一币种与计量单位；或切换到「涨跌幅」模式跨口径对比')
            return prev
          }
        }

        return [...prev, id]
      })
    },
    [byId, compareMode],
  )

  // 切回绝对价时,已选可能跨口径,收敛到首个品种所在口径组
  const switchCompareMode = useCallback(
    (next: CompareMode) => {
      setCompareMode(next)
      if (next === 'absolute') {
        setSelectedIds((prev) => {
          if (prev.length <= 1) return prev
          const first = byId.get(prev[0]!)
          if (!first) return prev
          const kept = prev.filter((id) => {
            const i = byId.get(id)
            return i != null && i.currencyId === first.currencyId && i.unitId === first.unitId
          })
          if (kept.length < prev.length) {
            toast.success('已切回绝对价对比，仅保留同口径品种')
          }
          return kept
        })
      }
    },
    [byId],
  )

  const series = seriesQuery.data?.series ?? []

  // 颜色以 series 顺序为准(与图线 stroke 一致),KPI 卡与品种 chip 共用同一映射
  const colorById = useMemo(() => {
    const m = new Map<string, string>()
    series.forEach((s, idx) => {
      m.set(s.instrumentId, CHART_COLORS[idx % CHART_COLORS.length]!)
    })
    return m
  }, [series])

  const chartData = useMemo(() => {
    const times = new Set<string>()
    for (const s of series) {
      for (const p of s.points) times.add(p.observedAt)
    }
    // 涨跌幅模式:各系列以窗内首个有效点为基准折算 %
    const baseById = new Map<string, number>()
    if (compareMode === 'percent') {
      for (const s of series) {
        if (s.points.length > 0) baseById.set(s.instrumentId, Number(s.points[0]!.price))
      }
    }
    const sorted = [...times].sort()
    return sorted.map((t) => {
      const row: Record<string, string | number> = {
        t,
        label: formatAxisTime(t),
      }
      for (const s of series) {
        const pt = s.points.find((p) => p.observedAt === t)
        // 缺测点不写 key,Line 断线(connectNulls 处理稀疏)
        if (!pt) continue
        const v = Number(pt.price)
        const base = baseById.get(s.instrumentId)
        if (compareMode === 'percent' && base != null && base !== 0) {
          row[s.code] = (v / base - 1) * 100
          // tooltip 展示原始价
          row[`${s.code}__raw`] = v
        } else {
          row[s.code] = v
        }
      }
      return row
    })
  }, [series, compareMode])

  const kpis = useMemo(() => {
    return series.map((s) => {
      const color = colorById.get(s.instrumentId) ?? CHART_COLORS[0]!
      const pts = s.points
      if (pts.length === 0) {
        return {
          id: s.instrumentId,
          name: s.name,
          code: s.code,
          color,
          last: null as number | null,
          changePct: null as number | null,
        }
      }
      const first = Number(pts[0]!.price)
      const last = Number(pts[pts.length - 1]!.price)
      const changePct = first === 0 ? null : ((last - first) / first) * 100
      return {
        id: s.instrumentId,
        name: s.name,
        code: s.code,
        color,
        last,
        changePct,
      }
    })
  }, [series, colorById])

  const scaleHint = useMemo(() => {
    if (compareMode === 'percent') return null
    if (selectedIds.length === 0) return null
    const first = byId.get(selectedIds[0]!)
    if (!first) return null
    const parts = [first.currencyCode, first.unitName].filter(Boolean)
    return parts.length ? parts.join(' / ') : null
  }, [selectedIds, byId, compareMode])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const result = await refreshMarketPricePoints()
      toast.success(summarizeRefresh(result))
      queryClient.invalidateQueries({
        queryKey: ['gridRows', marketPricePointClient.id, 'basMarketPricePoints'],
      })
      queryClient.invalidateQueries({ queryKey: ['marketPriceSeries'] })
      queryClient.invalidateQueries({ queryKey: ['marketChartInstruments'] })
      queryClient.invalidateQueries({ queryKey: ['sysSetting'] })
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  function applyChartFilterToGrid() {
    if (selectedIds.length === 0) {
      toast.danger('请先勾选品种')
      return
    }
    const labels = selectedIds.map((id) => byId.get(id)?.name ?? id)
    setPriceFilters({
      instrumentId: { kind: 'fk', values: selectedIds, labels },
    })
    setGridFilterKey((k) => k + 1)
    navigate({ search: { tab: 'prices' } })
    toast.success('已按勾选品种筛选价点表')
  }

  function clearChartFilterOnGrid() {
    setPriceFilters({})
    setGridFilterKey((k) => k + 1)
  }

  const st = statusQuery.data
  const showChart = canPriceRead
  const showPriceTab = canPriceRead
  const showInstrumentTab = canInstrumentRead

  // 拉取状态压缩为一行摘要,挂在走势图卡副标题
  const statusLine = useMemo(() => {
    if (!st) return null
    const parts: string[] = [
      st.marketFetchScheduleEnabled
        ? `交易时段每 ${st.marketFetchLastIntervalMinutes} 分钟自动拉取`
        : '自动拉取已关闭，仅手动刷新',
    ]
    if (st.marketFetchScheduleEnabled) {
      parts.push(st.marketFetchSettlementEnabled ? '工作日 15:30 起补结算价' : '结算补拉已关')
    }
    parts.push(`上次 ${formatRunAt(st.marketFetchLastRunAt)}`)
    if (st.marketFetchLastSummary) parts.push(st.marketFetchLastSummary)
    return parts.join(' · ')
  }, [st])

  const showKpis =
    showChart && selectedIds.length > 0 && (kpis.length > 0 || seriesQuery.isLoading)
  const noAccess = !permissionsPending && !canPriceRead && !canInstrumentRead

  if (permissionsPending) {
    return <Spinner className="mx-auto mt-12" aria-label="正在加载行情权限" />
  }

  if (permissionsError) {
    return (
      <EmptyState className="mt-12">
        <EmptyState.Header>
          <EmptyState.Title>行情加载失败</EmptyState.Title>
          <EmptyState.Description>
            {permissionsError instanceof Error ? permissionsError.message : '无法读取行情权限'}
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    )
  }

  if (noAccess) {
    return (
      <EmptyState className="mt-12">
        <EmptyState.Header>
          <EmptyState.Title>无行情权限</EmptyState.Title>
          <EmptyState.Description>
            请联系管理员分配行情品种或价点查看权限。
          </EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-brand text-3xl tracking-wide">行情</h1>
          <p className="mt-2 text-sm text-ink-500">
            期货与现货参考价：多品种走势对比、价点补录与品种主数据维护。只观测、落库，不持仓不记账。
          </p>
        </div>
        {canPriceCreate && (
          <Button variant="secondary" isPending={refreshing} onPress={handleRefresh}>
            刷新行情
          </Button>
        )}
      </div>

      {/* KPI:选中品种的最新价与窗内涨跌(图线同色) */}
      {showKpis && (
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.length === 0
            ? selectedIds.map((id) => <Skeleton key={id} className="h-24 rounded-2xl" />)
            : kpis.map((k) => (
                <KPI key={k.id}>
                  <KPI.Header>
                    <KPI.Title>
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: k.color }}
                        />
                        <span className="truncate">{k.name}</span>
                        <span className="shrink-0 font-mono text-xs font-normal text-ink-500/80">
                          {k.code}
                        </span>
                      </span>
                    </KPI.Title>
                  </KPI.Header>
                  <KPI.Content>
                    {k.last == null ? (
                      <span className="text-sm text-ink-500">窗内暂无价点</span>
                    ) : (
                      <>
                        <KPI.Value maximumFractionDigits={2} value={k.last} />
                        {k.changePct != null && (
                          <KPI.Trend
                            trend={k.changePct > 0 ? 'up' : k.changePct < 0 ? 'down' : 'neutral'}
                            variant="tertiary"
                            size="sm"
                          >
                            {k.changePct > 0 ? '+' : ''}
                            {k.changePct.toFixed(2)}%
                            <TrendChip.Suffix>窗内</TrendChip.Suffix>
                          </KPI.Trend>
                        )}
                      </>
                    )}
                  </KPI.Content>
                </KPI>
              ))}
        </div>
      )}

      {/* 走势对比 */}
      {showChart && (
        <Card className={showKpis ? 'mt-4' : 'mt-6'}>
          <Card.Header className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <Card.Title className="text-base">走势对比</Card.Title>
              {statusLine && (
                <p className="mt-1 text-xs font-normal text-ink-500">
                  {statusLine}
                  {' · '}
                  <Link
                    to="/base/settings/market-fetch"
                    className="text-ink-800 underline-offset-4 hover:underline"
                  >
                    拉取设置
                  </Link>
                </p>
              )}
            </div>
            {scaleHint && (
              <Chip size="sm" variant="soft" className="mt-0.5 shrink-0">
                <Chip.Label>口径 {scaleHint}</Chip.Label>
              </Chip>
            )}
            {compareMode === 'percent' && (
              <Chip size="sm" variant="soft" className="mt-0.5 shrink-0">
                <Chip.Label>涨跌幅 % · 基准=窗内首点</Chip.Label>
              </Chip>
            )}
          </Card.Header>
          <Card.Content className="flex flex-col gap-4">
            {/* 工具行 */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Segment
                selectedKey={priceKind}
                size="sm"
                onSelectionChange={(key) => {
                  if (key === 'settlement' || key === 'average' || key === 'last') {
                    setPriceKind(key)
                  }
                }}
              >
                {(Object.keys(PRICE_KIND_LABEL) as PriceKind[]).map((k) => (
                  <Segment.Item key={k} id={k}>
                    {PRICE_KIND_LABEL[k]}
                  </Segment.Item>
                ))}
              </Segment>

              <Segment
                selectedKey={rangePreset === 'custom' ? 'custom' : rangePreset}
                size="sm"
                onSelectionChange={(key) => {
                  const k = String(key)
                  if (k === '7' || k === '30' || k === '90' || k === '365' || k === 'custom') {
                    setRangePreset(k)
                  }
                }}
              >
                {(Object.keys(RANGE_LABEL) as Array<keyof typeof RANGE_LABEL>).map((k) => (
                  <Segment.Item key={k} id={k}>
                    {RANGE_LABEL[k]}
                  </Segment.Item>
                ))}
                <Segment.Item id="custom">自定义</Segment.Item>
              </Segment>

              {rangePreset === 'custom' && (
                <DateRangePicker
                  aria-label="自定义时间范围"
                  value={
                    customFrom && customTo
                      ? { start: parseDate(customFrom), end: parseDate(customTo) }
                      : null
                  }
                  onChange={(range) => {
                    if (!range) return
                    setCustomFrom(range.start.toString())
                    setCustomTo(range.end.toString())
                  }}
                >
                  <DateField.Group variant="secondary">
                    <DateField.Input slot="start">
                      {(segment) => <DateField.Segment segment={segment} />}
                    </DateField.Input>
                    <DateRangePicker.RangeSeparator />
                    <DateField.Input slot="end">
                      {(segment) => <DateField.Segment segment={segment} />}
                    </DateField.Input>
                    <DateField.Suffix>
                      <DateRangePicker.Trigger>
                        <DateRangePicker.TriggerIndicator />
                      </DateRangePicker.Trigger>
                    </DateField.Suffix>
                  </DateField.Group>
                  <DateRangePicker.Popover>
                    <RangeCalendar aria-label="日期区间">
                      <RangeCalendar.Header>
                        <RangeCalendar.YearPickerTrigger>
                          <RangeCalendar.YearPickerTriggerHeading />
                          <RangeCalendar.YearPickerTriggerIndicator />
                        </RangeCalendar.YearPickerTrigger>
                        <RangeCalendar.NavButton slot="previous" />
                        <RangeCalendar.NavButton slot="next" />
                      </RangeCalendar.Header>
                      <RangeCalendar.Grid>
                        <RangeCalendar.GridHeader>
                          {(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}
                        </RangeCalendar.GridHeader>
                        <RangeCalendar.GridBody>
                          {(date) => <RangeCalendar.Cell date={date} />}
                        </RangeCalendar.GridBody>
                      </RangeCalendar.Grid>
                    </RangeCalendar>
                  </DateRangePicker.Popover>
                </DateRangePicker>
              )}

              <Segment
                selectedKey={compareMode}
                size="sm"
                aria-label="对比模式"
                onSelectionChange={(key) => {
                  if (key === 'absolute' || key === 'percent') switchCompareMode(key)
                }}
              >
                <Segment.Item id="absolute">绝对价</Segment.Item>
                <Segment.Item id="percent">涨跌幅</Segment.Item>
              </Segment>

              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onPress={applyChartFilterToGrid}>
                  筛选价点表
                </Button>
                {Object.keys(priceFilters).length > 0 && (
                  <Button size="sm" variant="ghost" onPress={clearChartFilterOnGrid}>
                    清除筛选
                  </Button>
                )}
              </div>
            </div>

            {/* 品种 chips：点选即上图 */}
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-ink-900">对比品种</span>
                <span className="text-xs text-ink-500">
                  {compareMode === 'percent'
                    ? `涨跌幅模式可跨币种/单位同图，最多 ${MAX_SERIES} 个`
                    : `同币种同单位方可同图，最多 ${MAX_SERIES} 个；跨口径请切「涨跌幅」`}
                  {selectedIds.length > 0 ? ` · 已选 ${selectedIds.length}` : ''}
                </span>
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-label="对比品种">
                {instrumentsQuery.isLoading && <Spinner size="sm" />}
                {instrumentsQuery.isError && (
                  <span className="text-sm text-danger">
                    品种列表加载失败
                    {instrumentsQuery.error instanceof Error
                      ? `：${instrumentsQuery.error.message}`
                      : ''}
                  </span>
                )}
                {!instrumentsQuery.isLoading &&
                  !instrumentsQuery.isError &&
                  instruments.length === 0 && (
                    <span className="text-sm text-ink-500">
                      暂无启用品种。请到下方「品种维护」启用或新建。
                    </span>
                  )}
                {instruments.map((inst) => {
                  const on = selectedIds.includes(inst.id)
                  return (
                    <button
                      key={inst.id}
                      type="button"
                      aria-pressed={on}
                      title={
                        on
                          ? `取消勾选 ${inst.name}`
                          : `勾选 ${inst.name}（${inst.currencyCode ?? ''}/${inst.unitName ?? ''}）`
                      }
                      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                      onClick={() => toggleInstrument(inst.id)}
                    >
                      <Chip
                        color={on ? 'accent' : 'default'}
                        variant={on ? 'primary' : 'secondary'}
                        className="select-none"
                      >
                        <Chip.Label>
                          <span className="inline-flex items-center gap-1.5">
                            {on && (
                              <span
                                className="size-2 rounded-full ring-1 ring-white/50"
                                style={{
                                  backgroundColor: colorById.get(inst.id) ?? 'currentColor',
                                }}
                              />
                            )}
                            {inst.name}
                            <span className="font-mono text-[10px] opacity-70">
                              {inst.code}
                            </span>
                          </span>
                        </Chip.Label>
                      </Chip>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 图 */}
            <div className="relative min-h-[320px]">
              {seriesQuery.isFetching && !seriesQuery.isLoading && (
                <div className="absolute right-1 top-1 z-10">
                  <Spinner size="sm" />
                </div>
              )}
              {seriesQuery.isLoading && (
                <div className="flex h-[320px] items-center justify-center">
                  <Spinner />
                </div>
              )}
              {seriesQuery.isError && (
                <EmptyState size="sm">
                  <EmptyState.Header>
                    <EmptyState.Title>加载失败</EmptyState.Title>
                    <EmptyState.Description>
                      {seriesQuery.error instanceof Error
                        ? seriesQuery.error.message
                        : '无法加载行情时序'}
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              )}
              {!seriesQuery.isLoading && !seriesQuery.isError && selectedIds.length === 0 && (
                <EmptyState size="sm">
                  <EmptyState.Header>
                    <EmptyState.Title>尚未选择对比品种</EmptyState.Title>
                    <EmptyState.Description>
                      {compareMode === 'percent'
                        ? `请点击上方「对比品种」区域的标签进行勾选；涨跌幅模式可跨币种/单位同图，最多 ${MAX_SERIES} 个。`
                        : `请点击上方「对比品种」区域的标签（如沪铜、沪铝）进行勾选；同币种且同计量单位才能同图，最多 ${MAX_SERIES} 个。`}
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              )}
              {!seriesQuery.isLoading &&
                !seriesQuery.isError &&
                selectedIds.length > 0 &&
                chartData.length === 0 && (
                  <EmptyState size="sm">
                    <EmptyState.Header>
                      <EmptyState.Title>暂无价点</EmptyState.Title>
                      <EmptyState.Description>
                        当前价类与时间范围内没有有效价点。可切换价类/区间，或补录、刷新行情。
                      </EmptyState.Description>
                    </EmptyState.Header>
                  </EmptyState>
                )}
              {!seriesQuery.isLoading && chartData.length > 0 && (
                <LineChart data={chartData} height={320}>
                  <LineChart.Grid vertical={false} />
                  <LineChart.XAxis dataKey="label" tickMargin={8} minTickGap={32} />
                  <LineChart.YAxis
                    width={56}
                    domain={([dataMin, dataMax]: [number, number]) => {
                      // 区间上下留 8% 余量,并按数量级取整使刻度整齐;
                      // 绝对价不贴 0 轴(价格不会到 0),涨跌幅可正可负不截断
                      const raw = dataMax - dataMin
                      const pad = raw > 0 ? raw * 0.08 : Math.max(Math.abs(dataMax) * 0.02, 1)
                      const mag = 10 ** Math.floor(Math.log10(raw > 0 ? raw : pad))
                      const lo = Math.floor((dataMin - pad) / mag) * mag
                      const hi = Math.ceil((dataMax + pad) / mag) * mag
                      return compareMode === 'percent' ? [lo, hi] : [Math.max(0, lo), hi]
                    }}
                    tickFormatter={(v: number) => {
                      if (compareMode === 'percent') return `${Number(v.toFixed(6))}%`
                      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${v}`
                    }}
                  />
                  {compareMode === 'percent' && (
                    <ReferenceLine
                      y={0}
                      stroke="currentColor"
                      strokeOpacity={0.25}
                      strokeDasharray="4 4"
                    />
                  )}
                  {series.map((s, idx) => (
                    <LineChart.Line
                      key={s.instrumentId}
                      dataKey={s.code}
                      name={s.name}
                      dot={false}
                      connectNulls
                      stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                      strokeWidth={2}
                      type="monotone"
                    />
                  ))}
                  <LineChart.Tooltip
                    content={({ active, label, payload }) => {
                      if (!active || !payload?.length) return null
                      return (
                        <ChartTooltip>
                          <ChartTooltip.Header>{String(label ?? '')}</ChartTooltip.Header>
                          {payload.map((entry) => (
                            <ChartTooltip.Item key={String(entry.dataKey)}>
                              <ChartTooltip.Indicator
                                color={entry.color ?? entry.stroke ?? undefined}
                              />
                              <ChartTooltip.Label>{entry.name}</ChartTooltip.Label>
                              <ChartTooltip.Value>
                                {entry.value == null
                                  ? '—'
                                  : compareMode === 'percent'
                                    ? (() => {
                                        const pct = Number(entry.value)
                                        const raw = (
                                          entry.payload as Record<string, unknown> | undefined
                                        )?.[`${String(entry.dataKey)}__raw`]
                                        const sign = pct > 0 ? '+' : ''
                                        return raw == null
                                          ? `${sign}${pct.toFixed(2)}%`
                                          : `${sign}${pct.toFixed(2)}%（${formatPrice(Number(raw))}）`
                                      })()
                                    : formatPrice(Number(entry.value))}
                              </ChartTooltip.Value>
                            </ChartTooltip.Item>
                          ))}
                        </ChartTooltip>
                      )
                    }}
                  />
                </LineChart>
              )}
            </div>
          </Card.Content>
        </Card>
      )}

      {/* Tabs */}
      {(showPriceTab || showInstrumentTab) && (
        <Tabs
          variant="secondary"
          selectedKey={tab}
          onSelectionChange={(key) => {
            const k = String(key)
            if (k === 'prices' || k === 'instruments') {
              navigate({ search: { tab: k } })
            }
          }}
          className="mt-6"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="行情维护" className="w-fit min-w-0 *:w-auto">
              {showPriceTab && (
                <Tabs.Tab id="prices">
                  价点明细
                  <Tabs.Indicator />
                </Tabs.Tab>
              )}
              {showInstrumentTab && (
                <Tabs.Tab id="instruments">
                  品种维护
                  <Tabs.Indicator />
                </Tabs.Tab>
              )}
            </Tabs.List>
          </Tabs.ListContainer>

          {showPriceTab && (
            <Tabs.Panel id="prices" className="pt-4">
              <SynieDataGrid
                key={`prices-${gridFilterKey}`}
                resource="basMarketPricePoints"
                client={marketPricePointClient}
                columns={PRICE_COLUMNS}
                defaultFilters={priceFilters}
                onView={(row) => setPriceDrawer({ mode: 'view', row })}
                onCreate={() => setPriceDrawer({ mode: 'create', row: null })}
                actionVisible={ACTION_VISIBLE}
              />
            </Tabs.Panel>
          )}

          {showInstrumentTab && (
            <Tabs.Panel id="instruments" className="pt-4">
              <SynieDataGrid
                resource="basMarketInstruments"
                client={marketInstrumentClient}
                columns={INSTRUMENT_COLUMNS}
                onView={(row) => setInstrumentDrawer({ mode: 'view', row })}
                onCreate={() => setInstrumentDrawer({ mode: 'create', row: null })}
                onEdit={(row) => setInstrumentDrawer({ mode: 'edit', row })}
              />
            </Tabs.Panel>
          )}
        </Tabs>
      )}

      {/* 价点抽屉 */}
      <SynieRecordDrawer
        resource="basMarketPricePoints"
        client={marketPricePointClient}
        label="行情价点"
        mode={priceDrawer?.mode ?? 'view'}
        isOpen={priceDrawer !== null}
        onOpenChange={(open) => !open && setPriceDrawer(null)}
        row={priceDrawer?.row}
        exclude={
          priceDrawer?.mode === 'create'
            ? ['currencyId', 'unitId', 'isVoided', 'source', 'insertedAt', 'updatedAt']
            : ['insertedAt', 'updatedAt']
        }
        fields={{
          instrumentId: {
            required: true,
            edit: 'createOnly',
            remote: { client: marketInstrumentClient },
          },
          observedAt: { required: true, edit: 'createOnly' },
          price: { required: true, edit: 'createOnly', placeholder: '如 72000' },
          priceKind: { required: true, edit: 'createOnly' },
          note: { edit: 'createOnly', placeholder: '可选备注' },
        }}
        onSubmit={async (values, mode) => {
          if (mode !== 'create') return
          const saved = await marketPricePointClient.create(values)
          toast.success('行情价点已录入')
          queryClient.invalidateQueries({
            queryKey: ['gridRows', marketPricePointClient.id, 'basMarketPricePoints'],
          })
          queryClient.invalidateQueries({ queryKey: ['marketPriceSeries'] })
          return saved.id
        }}
      />

      {/* 品种抽屉 */}
      <SynieRecordDrawer
        resource="basMarketInstruments"
        client={marketInstrumentClient}
        label="行情品种"
        mode={instrumentDrawer?.mode ?? 'view'}
        isOpen={instrumentDrawer !== null}
        onOpenChange={(open) => !open && setInstrumentDrawer(null)}
        row={instrumentDrawer?.row}
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '如 SHFE_CU', cols: 6 },
          name: { required: true, placeholder: '如 沪铜', cols: 6 },
          sourceType: { required: true, cols: 6 },
          defaultPriceKind: { required: true, cols: 6 },
          currencyId: {
            required: true,
            edit: 'createOnly',
            cols: 6,
            remote: {
              client: currencyClient,
              filterState: { active: { kind: 'bool', eq: true } },
            },
          },
          unitId: {
            required: true,
            edit: 'createOnly',
            cols: 6,
            remote: { client: unitClient },
          },
          active: { defaultValue: true },
          fetchEnabled: { defaultValue: false },
          externalLastCode: { placeholder: '主连如 CU0', cols: 6 },
          externalProductGroup: { placeholder: '上期所组如 cu', cols: 6 },
          note: { placeholder: '可选备注' },
        }}
        onEdit={() =>
          setInstrumentDrawer((d) => (d ? { ...d, mode: 'edit' } : d))
        }
        onSubmit={async (values, mode) => {
          let saved: Row
          if (mode === 'create') {
            saved = await marketInstrumentClient.create(values)
          } else {
            const {
              code: _code,
              currencyId: _currencyId,
              unitId: _unitId,
              sourceType: _sourceType,
              ...update
            } = values
            saved = await marketInstrumentClient.update(instrumentDrawer!.row!.id, update)
          }
          toast.success(mode === 'create' ? '行情品种已创建' : '行情品种已更新')
          queryClient.invalidateQueries({
            queryKey: ['gridRows', marketInstrumentClient.id, 'basMarketInstruments'],
          })
          queryClient.invalidateQueries({ queryKey: ['marketChartInstruments'] })
          return saved.id
        }}
      />
    </>
  )
}
