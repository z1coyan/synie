import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Checkbox, Label, ListBox, Select, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/base/settings/market-fetch')({
  component: MarketFetchSettingsTab,
})

type SysSetting = {
  id: string
  marketFetchScheduleEnabled: boolean
  marketFetchLastIntervalMinutes: number
  marketFetchSettlementEnabled: boolean
  marketFetchLastRunAt: string | null
  marketFetchLastSummary: string | null
}

const SETTING_QUERY = `
  query {
    sysSetting {
      id
      marketFetchScheduleEnabled
      marketFetchLastIntervalMinutes
      marketFetchSettlementEnabled
      marketFetchLastRunAt
      marketFetchLastSummary
    }
  }
`

const UPDATE_SETTING = `
  mutation ($id: ID!, $input: UpdateSysSettingInput!) {
    updateSysSetting(id: $id, input: $input) { result { id } errors { message } }
  }
`

const INTERVALS = [
  { value: '30', label: '30 分钟' },
  { value: '60', label: '60 分钟' },
  { value: '120', label: '120 分钟' },
]

function formatRunAt(iso: string | null): string {
  if (!iso) return '尚未运行'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function scheduleBlurb(scheduleOn: boolean, interval: number, settlementOn: boolean): string {
  if (!scheduleOn) return '定时拉取已关闭（仅可手动刷新）。'
  const last = `交易时段（日盘约 09:00–15:00、有色夜盘约 21:00–次日 02:30，上海时区）每 ${interval} 分钟拉最新价`
  const settle = settlementOn
    ? '工作日约 15:30 起自动补拉结算价（失败会在 16:00/16:30/17:00 重试）'
    : '结算自动补拉已关闭'
  return `${last}；${settle}。`
}

function MarketFetchSettingsTab() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['sysSetting', 'marketFetch'],
    queryFn: () => gqlFetch<{ sysSetting: SysSetting | null }>(SETTING_QUERY),
  })

  const [scheduleEnabled, setScheduleEnabled] = useState(true)
  const [interval, setIntervalMinutes] = useState('60')
  const [settlementEnabled, setSettlementEnabled] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const s = query.data?.sysSetting
    if (!s) return
    setScheduleEnabled(s.marketFetchScheduleEnabled)
    setIntervalMinutes(String(s.marketFetchLastIntervalMinutes))
    setSettlementEnabled(s.marketFetchSettlementEnabled)
  }, [query.data])

  const intervalNum = Number(interval)

  const save = async () => {
    if (!query.data?.sysSetting) return
    if (![30, 60, 120].includes(intervalNum)) {
      toast.danger('最新价间隔仅允许 30 / 60 / 120 分钟')
      return
    }
    setSaving(true)
    try {
      const data = await gqlFetch<{ updateSysSetting: { errors: { message: string }[] | null } }>(
        UPDATE_SETTING,
        {
          id: query.data.sysSetting.id,
          input: {
            marketFetchScheduleEnabled: scheduleEnabled,
            marketFetchLastIntervalMinutes: intervalNum,
            marketFetchSettlementEnabled: settlementEnabled,
          },
        },
      )
      if (data.updateSysSetting.errors?.length) {
        throw new Error(data.updateSysSetting.errors.map((e) => e.message).join('; '))
      }
      toast.success('行情拉取设置已保存')
      queryClient.invalidateQueries({ queryKey: ['sysSetting'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const s = query.data?.sysSetting

  return (
    <>
      <p className="mb-4 text-sm text-ink-500">
        定时从外部价源写入行情价点。哪些品种参与由「行情品种」上的启用拉取与外部代码决定；此处只配置系统级节奏。
      </p>

      <Card className="max-w-2xl">
        <Card.Header>
          <Card.Title>定时规则</Card.Title>
          <Card.Description>
            {scheduleBlurb(scheduleEnabled, intervalNum || 60, settlementEnabled)}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {query.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-danger">加载失败:{(query.error as Error).message}</p>
          ) : (
            <div className="flex flex-col gap-5">
              <Checkbox isSelected={scheduleEnabled} onChange={setScheduleEnabled}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  启用定时拉取
                </Checkbox.Content>
              </Checkbox>

              <Select
                value={interval}
                onChange={(v) => v != null && setIntervalMinutes(String(v))}
                isDisabled={!scheduleEnabled}
              >
                <Label>最新价拉取间隔</Label>
                <Select.Trigger>
                  <Select.Value>
                    {({ isPlaceholder, defaultChildren }) =>
                      isPlaceholder ? '请选择…' : defaultChildren
                    }
                  </Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {INTERVALS.map((t) => (
                      <ListBox.Item key={t.value} id={t.value} textValue={t.label}>
                        {t.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <p className="-mt-3 text-xs text-ink-500">仅在交易时段内生效；勿设过密以免触发免费源限流</p>

              <Checkbox
                isSelected={settlementEnabled}
                onChange={setSettlementEnabled}
                isDisabled={!scheduleEnabled}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  启用日终结算自动补拉
                </Checkbox.Content>
              </Checkbox>

              <div>
                <Button isPending={saving} onPress={save}>
                  保存
                </Button>
              </div>
            </div>
          )}
        </Card.Content>
      </Card>

      <Card className="mt-4 max-w-2xl">
        <Card.Header>
          <Card.Title>上次运行</Card.Title>
          <Card.Description>手动与定时拉取共用同一摘要，便于排查是否静默失败。</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-2 text-sm">
          <p>
            <span className="text-ink-500">完成时间：</span>
            {formatRunAt(s?.marketFetchLastRunAt ?? null)}
          </p>
          <p>
            <span className="text-ink-500">结果：</span>
            {s?.marketFetchLastSummary ?? '—'}
          </p>
        </Card.Content>
      </Card>
    </>
  )
}
