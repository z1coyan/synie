import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(出入库);无权限时由布局静默改落到可访问 tab
export const Route = createFileRoute('/_app/scm/other-stock/')({
  beforeLoad: () => {
    throw redirect({ to: '/scm/other-stock/docs' })
  },
})
