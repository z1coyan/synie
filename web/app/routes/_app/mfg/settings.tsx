import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Label, NumberField, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/mfg/settings')({
  component: MfgSettingsPage,
})

const SETTING_QUERY = `
  query {
    mfgSetting { id outputOverreceiveRatio }
  }
`
const UPDATE_SETTING = `
  mutation ($id: ID!, $input: UpdateMfgSettingInput!) {
    updateMfgSetting(id: $id, input: $input) { result { id } errors { message } }
  }
`

type MfgSetting = {
  id: string
  outputOverreceiveRatio: string | number
}

function MfgSettingsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['mfgSetting'],
    queryFn: () => gqlFetch<{ mfgSetting: MfgSetting | null }>(SETTING_QUERY),
  })

  // 界面按百分比录入(0–100),落库小数 0–1;null=设置尚未载入
  const [overreceivePct, setOverreceivePct] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!query.data?.mfgSetting) return
    const ratio = Number(query.data.mfgSetting.outputOverreceiveRatio)
    setOverreceivePct(Number.isFinite(ratio) ? Math.round(ratio * 10000) / 100 : 0)
  }, [query.data])

  const save = async () => {
    if (!query.data?.mfgSetting) return
    if (overreceivePct === null || overreceivePct < 0 || overreceivePct > 100) {
      toast.danger('生产入库超入比例须在 0%–100% 之间')
      return
    }
    setSaving(true)
    try {
      const data = await gqlFetch<{ updateMfgSetting: { errors: { message: string }[] | null } }>(
        UPDATE_SETTING,
        {
          id: query.data.mfgSetting.id,
          input: { outputOverreceiveRatio: String(overreceivePct / 100) },
        },
      )
      if (data.updateMfgSetting.errors?.length) {
        throw new Error(data.updateMfgSetting.errors.map((e) => e.message).join('; '))
      }
      toast.success('生产设置已保存')
      queryClient.invalidateQueries({ queryKey: ['mfgSetting'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产设置</h1>
      <p className="mt-2 text-sm text-ink-500">生产域全局配置（非公司维度）。</p>

      <Card className="mt-6 max-w-2xl">
        <Card.Header>
          <Card.Title>生产入库容差</Card.Title>
          <Card.Description>
            生产入库超入比例：审核时要求该工单累计已入（含本单）≤ 工单数量 × (1 + 比例)。0% 禁超入。
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {query.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-danger">加载失败:{(query.error as Error).message}</p>
          ) : overreceivePct === null ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : (
            <NumberField
              fullWidth
              value={overreceivePct}
              onChange={setOverreceivePct}
              minValue={0}
              maxValue={100}
            >
              <Label>生产入库超入比例 (%)</Label>
              <NumberField.Group>
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
          )}
        </Card.Content>
        <Card.Footer>
          <Button
            variant="primary"
            isDisabled={query.isLoading || query.isError || overreceivePct === null}
            isPending={saving}
            onPress={save}
          >
            保存
          </Button>
        </Card.Footer>
      </Card>
    </>
  )
}
