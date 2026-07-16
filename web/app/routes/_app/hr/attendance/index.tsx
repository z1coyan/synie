import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(日考勤,计算结果主视图)
export const Route = createFileRoute('/_app/hr/attendance/')({
  beforeLoad: () => {
    throw redirect({ to: '/hr/attendance/days' })
  },
})
