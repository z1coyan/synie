import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Label, NumberField, Spinner, toast } from '@heroui/react'
import { getSalesSetting, updateSalesSetting } from '~/lib/resources/settings'
import { CompanyAccountDefaultsCard } from '~/components/company-account-defaults'
import { toastError } from '~/lib/toast'

export const Route = createFileRoute('/_app/purchase/settings')({
  component: PurchaseSettingsPage,
})

function PurchaseSettingsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({
    // 与销售 tab / 订单抽屉分 key,避免不同表单草稿互相污染缓存
    queryKey: ['salSetting', 'purchase'],
    queryFn: getSalesSetting,
  })

  const [spotMaxQty, setSpotMaxQty] = useState<number>(NaN)
  // 界面按百分比录入(0–100),落库小数 0–1
  const [overreceivePct, setOverreceivePct] = useState<number>(NaN)
  const [overorderPct, setOverorderPct] = useState<number>(NaN)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!query.data) return
    setSpotMaxQty(query.data.spotItemMaxQty)
    const receiveRatio = Number(query.data.receiptOverreceiveRatio)
    setOverreceivePct(Number.isFinite(receiveRatio) ? Math.round(receiveRatio * 10000) / 100 : 0)
    const orderRatio = Number(query.data.demandOverorderRatio)
    setOverorderPct(Number.isFinite(orderRatio) ? Math.round(orderRatio * 10000) / 100 : 0)
  }, [query.data])

  const save = async () => {
    if (!query.data) return
    if (!Number.isInteger(spotMaxQty) || spotMaxQty <= 0) {
      toast.danger('零星条目数量上限必须是正整数')
      return
    }
    if (!Number.isFinite(overreceivePct) || overreceivePct < 0 || overreceivePct > 100) {
      toast.danger('入库超收比例须在 0%–100% 之间')
      return
    }
    if (!Number.isFinite(overorderPct) || overorderPct < 0 || overorderPct > 100) {
      toast.danger('需求超安排比例须在 0%–100% 之间')
      return
    }
    setSaving(true)
    try {
      await updateSalesSetting({
        spotItemMaxQty: spotMaxQty,
        receiptOverreceiveRatio: String(overreceivePct / 100),
        demandOverorderRatio: String(overorderPct / 100),
      })
      toast.success('采购设置已保存')
      queryClient.invalidateQueries({ queryKey: ['salSetting'] })
    } catch (e) {
      toastError('保存失败')(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-xl">采购设置</h1>
      <p className="mt-1 text-xs text-ink-500">采购全局配置（非公司维度）。</p>
      <Card className="mt-4 max-w-2xl">
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

      <Card className="mt-4 max-w-2xl">
        <Card.Header>
          <Card.Title>履约需求下单</Card.Title>
          <Card.Description>
            超安排比例:工单创建、采购/委外审核、库存/关闭安排时允许累计已安排 ≤ 需求数量 × (1 +
            比例)。0% 表示禁止超安排。草稿采购不占量；关闭安排不吃本容差。
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
              // 产品名：需求超安排比例（存储列仍为 demand_overorder_ratio）
              value={overorderPct}
              onChange={setOverorderPct}
              minValue={0}
              maxValue={100}
            >
              <Label>需求超安排比例(%)</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input placeholder="如 0 或 5" />
              </NumberField.Group>
            </NumberField>
          )}
        </Card.Content>
      </Card>

      <CompanyAccountDefaultsCard side="receipt" />

      {!query.isLoading && !query.isError && (
        <div className="mt-4">
          <Button isPending={saving} onPress={save}>
            保存
          </Button>
        </div>
      )}
    </>
  )
}
