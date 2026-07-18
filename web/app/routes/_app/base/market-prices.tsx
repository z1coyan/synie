import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, toast } from '@heroui/react'
import { gqlFetch, isForbidden } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/base/market-prices')({
  component: MarketPricesPage,
})

const CREATE = `
  mutation ($input: CreateBasMarketPricePointInput!) {
    createBasMarketPricePoint(input: $input) { result { id } errors { message } }
  }
`

const REFRESH = `
  mutation ($input: RefreshBasMarketPricePointsInput) {
    refreshBasMarketPricePoints(input: $input)
  }
`

const STATUS_QUERY = `
  query {
    sysSetting {
      marketFetchScheduleEnabled
      marketFetchLastIntervalMinutes
      marketFetchSettlementEnabled
      marketFetchLastRunAt
      marketFetchLastSummary
    }
  }
`

const GRID_COLUMNS = [
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

const ACTION_VISIBLE = {
  void: (row: Row) => row.isVoided !== true,
} satisfies Record<string, (row: Row) => boolean>

type RefreshItem = {
  code?: string
  kind?: string
  status?: string
  message?: string | null
}

type FetchStatus = {
  marketFetchScheduleEnabled: boolean
  marketFetchLastIntervalMinutes: number
  marketFetchSettlementEnabled: boolean
  marketFetchLastRunAt: string | null
  marketFetchLastSummary: string | null
}

function summarizeRefresh(raw: unknown): string {
  const payload = raw as { items?: RefreshItem[] } | null
  const items = payload?.items ?? []
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

function formatRunAt(iso: string | null): string {
  if (!iso) return '尚未运行'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function MarketPricesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const queryClient = useQueryClient()

  const statusQuery = useQuery({
    queryKey: ['sysSetting', 'marketFetchStatus'],
    queryFn: async () => {
      try {
        const data = await gqlFetch<{ sysSetting: FetchStatus | null }>(STATUS_QUERY)
        return data.sysSetting
      } catch (e) {
        if (isForbidden(e)) return null
        throw e
      }
    },
    staleTime: 30_000,
  })

  async function handleRefresh() {
    setRefreshing(true)
    try {
      const data = await gqlFetch<{ refreshBasMarketPricePoints: unknown }>(REFRESH, {
        input: {},
      })
      toast.success(summarizeRefresh(data.refreshBasMarketPricePoints))
      queryClient.invalidateQueries({ queryKey: ['gridRows', 'basMarketPricePoints'] })
      queryClient.invalidateQueries({ queryKey: ['sysSetting'] })
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  const st = statusQuery.data

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-brand text-3xl tracking-wide">行情价点</h1>
          <p className="mt-2 text-sm text-ink-500">
            不可变价格事实：按品种 + 观测时刻补录或拉取；录错请作废后重录，不可改价。币种与单位自动继承自品种。
          </p>
        </div>
        <Button variant="secondary" isPending={refreshing} onPress={handleRefresh}>
          刷新行情
        </Button>
      </div>

      {st && (
        <Card className="mt-4">
          <Card.Content className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
            <div className="space-y-0.5 text-ink-500">
              <p>
                {st.marketFetchScheduleEnabled
                  ? `定时：交易时段每 ${st.marketFetchLastIntervalMinutes} 分钟拉最新价` +
                    (st.marketFetchSettlementEnabled
                      ? '；工作日 15:30 起补结算价'
                      : '；结算自动补拉已关')
                  : '定时拉取已关闭（仅手动刷新）'}
              </p>
              <p>
                上次：{formatRunAt(st.marketFetchLastRunAt)}
                {st.marketFetchLastSummary ? ` · ${st.marketFetchLastSummary}` : ''}
              </p>
            </div>
            <Link
              to="/base/settings/market-fetch"
              className="shrink-0 text-sm text-ink-900 underline-offset-4 hover:underline"
            >
              拉取设置
            </Link>
          </Card.Content>
        </Card>
      )}

      <div className="mt-6">
        <SynieDataGrid
          resource="basMarketPricePoints"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          actionVisible={ACTION_VISIBLE}
        />
      </div>

      <SynieRecordDrawer
        resource="basMarketPricePoints"
        label="行情价点"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        exclude={
          drawer?.mode === 'create'
            ? ['currencyId', 'unitId', 'isVoided', 'source', 'insertedAt', 'updatedAt']
            : ['insertedAt', 'updatedAt']
        }
        fields={{
          instrumentId: { required: true, edit: 'createOnly' },
          observedAt: { required: true, edit: 'createOnly' },
          price: { required: true, edit: 'createOnly', placeholder: '如 72000' },
          priceKind: {
            required: true,
            edit: 'createOnly',
          },
          note: { edit: 'createOnly', placeholder: '可选备注' },
        }}
        onSubmit={async (values, mode) => {
          if (mode !== 'create') return
          const input = { ...values, source: 'MANUAL' } as Record<string, unknown>

          const data = await gqlFetch<{
            createBasMarketPricePoint: { errors: { message: string }[] | null }
          }>(CREATE, { input })
          const errors = data.createBasMarketPricePoint.errors
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success('行情价点已录入')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'basMarketPricePoints'] })
        }}
      />
    </>
  )
}
