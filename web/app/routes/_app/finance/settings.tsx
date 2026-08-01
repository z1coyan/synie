import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Card, Spinner } from '@heroui/react'
import { getAccountingOCRConfigured } from '~/lib/resources/settings'

export const Route = createFileRoute('/_app/finance/settings')({
  component: FinanceSettingsPage,
})

function FinanceSettingsPage() {
  const query = useQuery({
    queryKey: ['accOcrConfigured'],
    queryFn: getAccountingOCRConfigured,
  })

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">财务设置</h1>
      <p className="mt-2 text-sm text-ink-500">
        票据 OCR 的访问凭证由运维在部署环境中统一配置，业务数据与浏览器均不保存密钥。
      </p>

      <Card className="mt-6 max-w-2xl">
        <Card.Header>
          <Card.Title>票据 OCR(阿里云)</Card.Title>
          <Card.Description>
            本页只显示可用状态；需要启用或轮换凭证时请联系管理员。
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {query.isLoading ? (
            <div className="flex justify-center py-6">
              <Spinner size="sm" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-danger">加载失败:{(query.error as Error).message}</p>
          ) : <p className="text-sm text-ink-700">
            当前状态：{query.data?.configured ? '已配置，可使用' : '未配置，请联系管理员'}
          </p>}
        </Card.Content>
      </Card>
    </>
  )
}
