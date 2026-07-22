import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/system/companies')({
  component: CompaniesPage,
})

const CREATE_COMPANY = `
  mutation ($input: CreateBasCompanyInput!) {
    createBasCompany(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_COMPANY = `
  mutation ($id: ID!, $input: UpdateBasCompanyInput!) {
    updateBasCompany(id: $id, input: $input) { result { id } errors { message } }
  }
`
// 默认仓库种子(所有仓库/默认仓库/在途):泛型 action 返回标量(新建条数),幂等;失败走 top-level errors 由 gqlFetch 抛出
const SEED_WAREHOUSE_DEFAULTS = `
  mutation ($input: SeedInvWarehouseDefaultsInput!) {
    seedInvWarehouseDefaults(input: $input)
  }
`

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
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="basCompanies"
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
            remote: { filter: '{active: {eq: true}}' },
          },
          // parentId 是 fk 列,零配置自动出 RemoteSelect;要弹窗选择时:parentId: { picker: 'dialog' }
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          let createdId: string | null = null
          if (mode === 'create') {
            const data = await gqlFetch<{
              createBasCompany: { result: { id: string } | null; errors: { message: string }[] | null }
            }>(CREATE_COMPANY, { input: values })
            errors = data.createBasCompany.errors
            createdId = data.createBasCompany.result?.id ?? null
          } else {
            const data = await gqlFetch<{ updateBasCompany: { errors: { message: string }[] | null } }>(
              UPDATE_COMPANY,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateBasCompany.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          // 建新公司后种子默认仓库;失败只报错不回滚公司(种子幂等,可重建公司或手工补仓)
          let seedNote = ''
          if (createdId) {
            try {
              const seed = await gqlFetch<{ seedInvWarehouseDefaults: number }>(SEED_WAREHOUSE_DEFAULTS, {
                input: { companyId: createdId },
              })
              seedNote = `,并初始化 ${seed.seedInvWarehouseDefaults} 个默认仓库`
            } catch (e) {
              toast.danger('初始化默认仓库失败', { description: (e as Error).message })
            }
          }
          toast.success(mode === 'create' ? `公司已创建${seedNote}` : '公司已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'basCompanies'] })
        }}
      />
    </>
  )
}
