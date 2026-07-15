import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Input, Label, Spinner, TextField, toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'

export const Route = createFileRoute('/_app/system/finance')({
  component: FinanceSettingsPage,
})

const SETTING_QUERY = `
  query {
    accSetting { id ocrAccessKeyId ocrAccessKeySecret }
  }
`
const UPDATE_SETTING = `
  mutation ($id: ID!, $input: UpdateAccSettingInput!) {
    updateAccSetting(id: $id, input: $input) { result { id } errors { message } }
  }
`

interface Setting {
  id: string
  ocrAccessKeyId: string | null
  ocrAccessKeySecret: string | null
}

function FinanceSettingsPage() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['accSetting'],
    queryFn: () => gqlFetch<{ accSetting: Setting | null }>(SETTING_QUERY).then((d) => d.accSetting),
  })

  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)

  // 查询回填本地草稿(单行配置,页面即表单)
  useEffect(() => {
    if (query.data) {
      setKeyId(query.data.ocrAccessKeyId ?? '')
      setSecret(query.data.ocrAccessKeySecret ?? '')
    }
  }, [query.data])

  const save = async () => {
    if (!query.data) return
    setSaving(true)
    try {
      const data = await gqlFetch<{ updateAccSetting: { errors: { message: string }[] | null } }>(
        UPDATE_SETTING,
        { id: query.data.id, input: { ocrAccessKeyId: keyId || null, ocrAccessKeySecret: secret || null } }
      )
      if (data.updateAccSetting.errors && data.updateAccSetting.errors.length > 0) {
        throw new Error(data.updateAccSetting.errors.map((e) => e.message).join('; '))
      }
      toast.success('财务设置已保存')
      queryClient.invalidateQueries({ queryKey: ['accSetting'] })
      queryClient.invalidateQueries({ queryKey: ['accOcrConfigured'] })
    } catch (e) {
      toast.danger('保存失败', { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">财务设置</h1>
      <p className="mt-2 text-sm text-ink-500">
        财务模块全局配置。阿里云 OCR 凭证用于发票/承兑汇票的票面识别,留空即停用识别入口。
      </p>

      <Card className="mt-6 max-w-2xl">
        <Card.Header>
          <Card.Title>票据 OCR(阿里云)</Card.Title>
          <Card.Description>
            阿里云 RAM 用户的 AccessKey,需授权 AliyunOCRFullAccess;仅本页与识别调用使用。
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
              <TextField value={keyId} onChange={setKeyId}>
                <Label>AccessKey ID</Label>
                <Input placeholder="如 LTAI5t…" />
              </TextField>
              <TextField value={secret} onChange={setSecret}>
                <Label>AccessKey Secret</Label>
                <Input type="password" placeholder="仅管理员可见,保存后生效" />
              </TextField>
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
