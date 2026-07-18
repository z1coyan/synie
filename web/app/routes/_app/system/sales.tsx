import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Label, NumberField, Spinner, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/system/sales')({
  component: SalesSettingsPage,
})

const SETTING_QUERY = `
  query {
    salSetting { id sampleItemMaxQty }
  }
`
const UPDATE_SETTING = `
  mutation ($id: ID!, $input: UpdateSalSettingInput!) {
    updateSalSetting(id: $id, input: $input) { result { id } errors { message } }
  }
`

function SalesSettingsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['salSetting'],
    queryFn: () => gqlFetch<{ salSetting: { id: string; sampleItemMaxQty: number } | null }>(SETTING_QUERY),
  })

  const [maxQty, setMaxQty] = useState<number>(NaN)
  const [saving, setSaving] = useState(false)

  // 查询回填本地草稿(单行配置,页面即表单,同财务设置页先例)
  useEffect(() => {
    if (query.data?.salSetting) setMaxQty(query.data.salSetting.sampleItemMaxQty)
  }, [query.data])

  const save = async () => {
    if (!query.data?.salSetting) return
    // 后端 check constraint/validation 兜底(>0 整数),这里做体验层拦截
    if (!Number.isInteger(maxQty) || maxQty <= 0) {
      toast.danger('样品条目数量上限必须是正整数')
      return
    }
    setSaving(true)
    try {
      const data = await gqlFetch<{ updateSalSetting: { errors: { message: string }[] | null } }>(UPDATE_SETTING, {
        id: query.data.salSetting.id,
        input: { sampleItemMaxQty: maxQty },
      })
      if (data.updateSalSetting.errors && data.updateSalSetting.errors.length > 0) {
        throw new Error(data.updateSalSetting.errors.map((e) => e.message).join('; '))
      }
      toast.success('销售设置已保存')
      queryClient.invalidateQueries({ queryKey: ['salSetting'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">销售设置</h1>
      <p className="mt-2 text-sm text-ink-500">销售模块全局配置(非公司维度)。样品订单条目自由录入,但单行数量不得越过上限。</p>

      <Card className="mt-6 max-w-2xl">
        <Card.Header>
          <Card.Title>样品订单</Card.Title>
          <Card.Description>
            样品订单单行数量上限:按行录入数量直接比较(不做单位换算),建行与订单审核同卡。
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
            <div className="flex flex-col gap-4">
              <NumberField fullWidth value={maxQty} onChange={setMaxQty} minValue={1}>
                <Label>样品条目数量上限</Label>
                {/* 库样式 group 给步进按钮留列;不渲染步进按钮时改单列让 input 撑满 */}
                <NumberField.Group className="grid-cols-[1fr]">
                  <NumberField.Input placeholder="如 100" />
                </NumberField.Group>
              </NumberField>
              <div>
                <Button isPending={saving} onPress={save}>
                  保存
                </Button>
              </div>
            </div>
          )}
        </Card.Content>
      </Card>
    </>
  )
}
