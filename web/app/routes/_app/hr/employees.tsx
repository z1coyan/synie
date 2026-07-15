import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/hr/employees')({
  component: EmployeesPage,
})

const CREATE_EMPLOYEE = `
  mutation ($input: CreateHrEmployeeInput!) {
    createHrEmployee(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_EMPLOYEE = `
  mutation ($id: ID!, $input: UpdateHrEmployeeInput!) {
    updateHrEmployee(id: $id, input: $input) { result { id } errors { message } }
  }
`

// 常用列白名单:户籍/现居住地长文本进详情看,给薪酬列留视口
const GRID_COLUMNS = ['code', 'name', 'attendanceNo', 'idNumber', 'phone', 'dailyWage', 'monthlyAllowance']

const GRID_OVERRIDES = {
  dailyWage: { render: (v) => (v == null || v === '' ? null : formatAmount(v)) },
  monthlyAllowance: { render: (v) => (v == null || v === '' ? null : formatAmount(v)) },
} satisfies Record<string, ColumnOverride>

function EmployeesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">员工档案</h1>
      <p className="mt-2 text-sm text-ink-500">员工主数据:基本信息、证件与薪酬标准,身份证照片在详情中维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="hrEmployees"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="hrEmployees"
        {...drawerConfig('hrEmployees')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无户籍/现居住地),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createHrEmployee: { errors: { message: string }[] | null } }>(
              CREATE_EMPLOYEE,
              { input: values }
            )
            errors = data.createHrEmployee.errors
          } else {
            const data = await gqlFetch<{ updateHrEmployee: { errors: { message: string }[] | null } }>(
              UPDATE_EMPLOYEE,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateHrEmployee.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '员工已创建,进入详情可上传身份证照片' : '员工已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'hrEmployees'] })
          // 抽屉走 rowId 自查,编辑后一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({ queryKey: ['rowById', 'hrEmployees'] })
        }}
      />
    </>
  )
}
