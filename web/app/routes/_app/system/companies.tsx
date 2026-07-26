import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { companyClient } from '~/lib/resources/companies'
import { currencyClient } from '~/lib/resources/currencies'

export const Route = createFileRoute('/_app/system/companies')({
  component: CompaniesPage,
})

function CompaniesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">公司管理</h1>
      <p className="mt-2 text-sm text-ink-500">多公司主数据与集团层级。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="basCompanies"
          client={companyClient}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="basCompanies"
        client={companyClient}
        label="公司"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        row={drawer?.row}
        fields={{
          code: { required: true, edit: 'createOnly', placeholder: '两位英文字母,如 SH' },
          name: { required: true, placeholder: '如 上海总部' },
          shortName: { required: true, placeholder: '如 上海' },
          // 本币:记账主体的记账货币,单据双币换算的目标口径(必填);仅启用币种可选
          baseCurrencyId: {
            required: true,
            label: '本币',
            remote: { client: currencyClient, filterState: { active: { kind: 'bool', eq: true } } },
          },
          parentId: { remote: { client: companyClient } },
          // parentId 是 fk 列,零配置自动出 RemoteSelect;要弹窗选择时:parentId: { picker: 'dialog' }
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await companyClient.create(values)
          } else {
            await companyClient.update(drawer!.row!.id, values)
          }
          toast.success(mode === 'create' ? '公司已创建,并初始化 3 个默认仓库' : '公司已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', companyClient.id, 'basCompanies'] })
        }}
      />
    </>
  )
}
