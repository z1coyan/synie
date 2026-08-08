import { createFileRoute, redirect } from '@tanstack/react-router'

/** 列表迁到 /sales/reconciliations;保留子路径以免旧书签/待办链断裂 */
export const Route = createFileRoute(
  '/_app/sales/reconciliations/reconciliations',
)({
  beforeLoad: () => {
    throw redirect({ to: '/sales/reconciliations' })
  },
})
