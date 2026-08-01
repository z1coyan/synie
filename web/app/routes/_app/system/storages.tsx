import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/system/storages')({
  component: RetiredStoragesPage,
})

function RetiredStoragesPage() {
  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">文件存储</h1>
      <p className="mt-2 text-sm text-ink-500">
        存储接入由部署环境统一配置；业务用户无需维护 local、S3 或 OSS 接入点。
      </p>
    </>
  )
}
