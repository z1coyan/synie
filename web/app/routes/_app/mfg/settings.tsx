import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Label, NumberField, Spinner, toast } from '@heroui/react'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import { getManufacturingSetting, updateManufacturingSetting } from '~/lib/resources/settings'
import { toastError } from '~/lib/toast'

export const Route = createFileRoute('/_app/mfg/settings')({
  component: MfgSettingsPage,
})

function MfgSettingsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['mfgSettings'],
    queryFn: getManufacturingSetting,
  })

  // 界面按百分比录入(0–100),落库小数 0–1;null=设置尚未载入
  const [overreceivePct, setOverreceivePct] = useState<number | null>(null)
  // 模具物料分类:建模具时自动创建的资产物料归入该分类;null=设置尚未载入
  const [moldCategoryId, setMoldCategoryId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!query.data) return
    const ratio = Number(query.data.outputOverreceiveRatio)
    setOverreceivePct(Number.isFinite(ratio) ? Math.round(ratio * 10000) / 100 : 0)
    setMoldCategoryId(query.data.moldCategoryId ?? null)
    setLoaded(true)
  }, [query.data])

  const save = async () => {
    if (!query.data) return
    if (overreceivePct === null || overreceivePct < 0 || overreceivePct > 100) {
      toast.danger('生产入库超入比例须在 0%–100% 之间')
      return
    }
    setSaving(true)
    try {
      await updateManufacturingSetting({
        outputOverreceiveRatio: String(overreceivePct / 100),
        moldCategoryId,
      })
      toast.success('生产设置已保存')
      queryClient.invalidateQueries({ queryKey: ['mfgSettings'] })
    } catch (e) {
      toastError('保存失败')(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">生产设置</h1>
      <p className="mt-2 text-sm text-ink-500">生产全局配置（非公司维度）。</p>
      <Card className="mt-4 max-w-2xl">
      <Card.Header>
        <Card.Title>生产入库容差与模具分类</Card.Title>
        <Card.Description>
          生产入库超入比例：审核时要求该工单累计已入（含本单）≤ 工单数量 × (1 +
          比例)。0% 禁超入。
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {query.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : query.isError ? (
          <p className="text-sm text-danger">加载失败:{(query.error as Error).message}</p>
        ) : !loaded ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <NumberField
              fullWidth
              // loaded 分支保证已回填非 null;?? 0 仅为收窄类型
              value={overreceivePct ?? 0}
              onChange={setOverreceivePct}
              minValue={0}
              maxValue={100}
            >
              <Label>生产入库超入比例 (%)</Label>
              <NumberField.Group className="grid-cols-[1fr]">
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
            <div>
              <RemoteSelect
                resource="invMaterialCategories"
                label="模具物料分类"
                placeholder="可空,选择叶子分类…"
                value={moldCategoryId}
                onChange={(id) => setMoldCategoryId(id)}
                filterState={{
                  isLeaf: { kind: 'bool', eq: true },
                  active: { kind: 'bool', eq: true },
                }}
                searchFields={['name', 'code']}
                itemSubtitleFields={['code']}
              />
              <p className="mt-1 text-xs text-muted">
                建模具时自动建的资产物料归入该分类。
              </p>
            </div>
          </div>
        )}
      </Card.Content>
      <Card.Footer>
        <Button
          variant="primary"
          isDisabled={query.isLoading || query.isError || !loaded}
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
