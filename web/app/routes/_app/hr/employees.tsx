import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { resourceBindingFor } from '~/lib/resources/registry'
import {
  createEmployeePresentation,
  submitEmployeeForm,
} from '~/lib/resources/presentation'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

export const Route = createFileRoute('/_app/hr/employees')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: EmployeesPage,
})

const RESOURCE = 'hrEmployees'

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
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const binding = resourceBindingFor(RESOURCE)
  const presentation = createEmployeePresentation(binding)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">员工档案</h1>
      <p className="mt-2 text-sm text-ink-500">员工主数据:基本信息、证件与薪酬标准,身份证照片在详情中维护。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={presentation.label}
        exclude={presentation.exclude}
        fields={presentation.fields}
        extraContent={presentation.extraContent}
        contentClassName="w-full lg:w-[640px]"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        // 表格列是白名单子集(无户籍/现居住地),行数据不全;走 rowId 自查完整记录
        rowId={drawer?.recordId ?? undefined}
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          const id = await submitEmployeeForm(
            presentation,
            values,
            mode,
            drawer?.recordId ?? undefined,
          )
          toast.success(mode === 'create' ? '员工已创建,进入详情可上传身份证照片' : '员工已更新')
          await binding.cache.invalidateAll(queryClient)
          return id
        }}
      />
    </>
  )
}
