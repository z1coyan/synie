import { createFileRoute, redirect } from '@tanstack/react-router'

// 裸路径落到默认 tab(工资单,核算+发放主动线)
export const Route = createFileRoute('/_app/hr/payroll/')({
  beforeLoad: () => {
    throw redirect({ to: '/hr/payroll/slips' })
  },
})
