import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { employeeClient } from '~/lib/resources/employees'

export const Route = createFileRoute('/_app/hr/employees')({
  component: EmployeesPage,
})

// 常用列白名单:户籍/现居住地长文本进详情看,给薪酬列留视口
const GRID_COLUMNS = [
  'code',
  'name',
  'attendanceNo',
  'idNumber',
  'phone',
  'dailyWage',
  'monthlyAllowance',
  'insuranceTypes',
]

// 卡片:姓名标题、工号副标题、电话/日薪/考勤机号摘要
const GRID_OVERRIDES = {
  name: { mobileRole: 'title' },
  code: { mobileRole: 'subtitle' },
  phone: { mobileRole: 'summary' },
  dailyWage: {
    mobileRole: 'summary',
    render: (v) => (v == null || v === '' ? null : formatAmount(v)),
  },
  attendanceNo: { mobileRole: 'summary' },
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
          client={employeeClient}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="hrEmployees"
        client={employeeClient}
        {...drawerConfig('hrEmployees')}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无户籍/现居住地),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          const saved =
            mode === 'create'
              ? await employeeClient.create(values)
              : await employeeClient.update(drawer!.row!.id, values)
          toast.success(mode === 'create' ? '员工已创建,进入详情可上传身份证照片' : '员工已更新')
          queryClient.invalidateQueries({
            queryKey: ['gridRows', employeeClient.id, 'hrEmployees'],
          })
          // 抽屉走 rowId 自查,编辑后一并失效行缓存,重开详情不吃 30s staleTime 的旧行
          queryClient.invalidateQueries({
            queryKey: ['rowById', employeeClient.id, 'hrEmployees'],
          })
          return saved.id
        }}
      />
    </>
  )
}
