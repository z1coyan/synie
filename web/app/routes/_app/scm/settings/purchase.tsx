import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Label, NumberField, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { CompanyAccountDefaultsCard } from './-company-account-defaults'

export const Route = createFileRoute('/_app/scm/settings/purchase')({
  component: ScmPurchaseSettingsTab,
})

const SETTING_QUERY = `
  query {
    salSetting { id spotItemMaxQty receiptOverreceiveRatio }
  }
`
const UPDATE_SETTING = `
  mutation ($id: ID!, $input: UpdateSalSettingInput!) {
    updateSalSetting(id: $id, input: $input) { result { id } errors { message } }
  }
`

type SalSetting = {
  id: string
  spotItemMaxQty: number
  receiptOverreceiveRatio: string | number
}

function ScmPurchaseSettingsTab() {
  const queryClient = useQueryClient()
  const query = useQuery({
    // 与销售 tab / 订单抽屉分 key,避免 GraphQL 字段集不同互相污染缓存
    queryKey: ['salSetting', 'purchase'],
    queryFn: () => gqlFetch<{ salSetting: SalSetting | null }>(SETTING_QUERY),
  })

  const [spotMaxQty, setSpotMaxQty] = useState<number>(NaN)
  // 界面按百分比录入(0–100),落库小数 0–1
  const [overreceivePct, setOverreceivePct] = useState<number>(NaN)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!query.data?.salSetting) return
    setSpotMaxQty(query.data.salSetting.spotItemMaxQty)
    const receiveRatio = Number(query.data.salSetting.receiptOverreceiveRatio)
    setOverreceivePct(Number.isFinite(receiveRatio) ? Math.round(receiveRatio * 10000) / 100 : 0)
  }, [query.data])

  const save = async () => {
    if (!query.data?.salSetting) return
    if (!Number.isInteger(spotMaxQty) || spotMaxQty <= 0) {
      toast.danger('零星条目数量上限必须是正整数')
      return
    }
    if (!Number.isFinite(overreceivePct) || overreceivePct < 0 || overreceivePct > 100) {
      toast.danger('入库超收比例须在 0%–100% 之间')
      return
    }
    setSaving(true)
    try {
      const data = await gqlFetch<{ updateSalSetting: { errors: { message: string }[] | null } }>(
        UPDATE_SETTING,
        {
          id: query.data.salSetting.id,
          input: {
            spotItemMaxQty: spotMaxQty,
            receiptOverreceiveRatio: String(overreceivePct / 100),
          },
        },
      )
      if (data.updateSalSetting.errors && data.updateSalSetting.errors.length > 0) {
        throw new Error(data.updateSalSetting.errors.map((e) => e.message).join('; '))
      }
      toast.success('采购设置已保存')
      queryClient.invalidateQueries({ queryKey: ['salSetting'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Card className="max-w-2xl">
        <Card.Header>
          <Card.Title>零星订单</Card.Title>
          <Card.Description>
            零星订单单行数量上限:按行录入数量直接比较(不做单位换算),常规订单不受此限;建行与订单审核同卡,改小不追溯存量草稿。
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
            <NumberField fullWidth value={spotMaxQty} onChange={setSpotMaxQty} minValue={1}>
              <Label>零星条目数量上限</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input placeholder="如 100" />
              </NumberField.Group>
            </NumberField>
          )}
        </Card.Content>
      </Card>

      <Card className="mt-4 max-w-2xl">
        <Card.Header>
          <Card.Title>采购入库</Card.Title>
          <Card.Description>
            超收比例:入库审核时允许累计已收 ≤ 订购数量 × (1 + 比例)。0% 表示禁止超收。
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {query.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : query.isError ? null : (
            <NumberField
              fullWidth
              value={overreceivePct}
              onChange={setOverreceivePct}
              minValue={0}
              maxValue={100}
            >
              <Label>入库超收比例(%)</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input placeholder="如 0 或 5" />
              </NumberField.Group>
            </NumberField>
          )}
        </Card.Content>
      </Card>

      {!query.isLoading && !query.isError && (
        <div className="mt-4">
          <Button isPending={saving} onPress={save}>
            保存
          </Button>
        </div>
      )}

      <CompanyAccountDefaultsCard side="receipt" />
    </>
  )
}
