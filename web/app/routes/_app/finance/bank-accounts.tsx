import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { statusToggleActions } from '~/components/synie-data-grid/status-actions'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/bank-accounts')({
  component: BankAccountsPage,
})

const CREATE_BANK_ACCOUNT = `
  mutation ($input: CreateAccBankAccountInput!) {
    createAccBankAccount(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_BANK_ACCOUNT = `
  mutation ($id: ID!, $input: UpdateAccBankAccountInput!) {
    updateAccBankAccount(id: $id, input: $input) { result { id } errors { message } }
  }
`

// 公司放首列;支行/备注/时间戳不进表格(有序白名单,兼当 exclude)
const GRID_COLUMNS = [
  'companyId',
  'alias',
  'bankName',
  'accountNo',
  'holderName',
  'currencyId',
  'accountId',
  'active',
]

function BankAccountsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">银行账户</h1>
      <p className="mt-2 text-sm text-ink-500">公司名下的银行账户主数据,为银行流水与对账做准备。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="accBankAccounts"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          rowActions={statusToggleActions({
            field: 'active',
            mutation: UPDATE_BANK_ACCOUNT,
            resultKey: 'updateAccBankAccount',
            rowLabel: (row) => String(row.alias ?? ''),
            // 抽屉走 rowId 自查,状态翻转后一并失效行缓存
            onDone: () => queryClient.invalidateQueries({ queryKey: ['rowById', 'accBankAccounts'] }),
          })}
        />
      </div>

      <SynieRecordDrawer
        resource="accBankAccounts"
        label="银行账户"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无支行/备注),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        // 启用是状态不是表单字段(规范):新建默认启用,停用(账户退出)走列表行动作
        exclude={['active']}
        fields={{
          // 公司提到最前(绑定科目候选依赖它);建后不可改(update 动作不收 company_id);
          // 换公司时清掉已选科目,避免跨公司科目挂错
          companyId: { required: true, order: -1, edit: 'createOnly', effects: () => ({ accountId: null }) },
          // 货币/绑定科目是 fk 列(meta 列序靠后),显式排序拉回账号之后
          alias: { order: 1, required: true, placeholder: '如 招行基本户' },
          bankName: { order: 2, required: true, cols: 6, placeholder: '如 招商银行' },
          branchName: { order: 3, cols: 6, placeholder: '如 深圳分行营业部' },
          holderName: { order: 4, required: true, placeholder: '通常与公司名一致' },
          accountNo: { order: 5, required: true, placeholder: '对公账号/卡号' },
          currencyId: {
            order: 6,
            required: true,
            cols: 6,
            remote: { filter: '{active: {eq: true}}' },
          },
          accountId: {
            order: 7,
            cols: 6,
            // 候选限定在所选公司、非汇总、启用科目(后端另有同公司/汇总/停用/币种校验兜底)
            input: ({ value, onChange, isDisabled, values }) => {
              const companyId = (values.companyId ?? null) as string | null
              return (
                <RemoteSelect
                  resource="basAccounts"
                  label="绑定科目"
                  placeholder={companyId ? '选择入账科目…' : '先选择公司'}
                  value={value == null ? null : String(value)}
                  onChange={(id) => onChange(id)}
                  isDisabled={isDisabled || companyId == null}
                  filter={`{companyId: {eq: ${JSON.stringify(companyId)}}, isGroup: {eq: false}, active: {eq: true}}`}
                />
              )
            },
          },
          note: { order: 9, placeholder: '用途说明等' },
        }}
        extraContent={(mode, row) => (
          <SynieAttachmentPanel
            ownerType="acc_bank_account"
            ownerId={row?.id as string | undefined}
            readonly={mode === 'view'}
          />
        )}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createAccBankAccount: { errors: { message: string }[] | null } }>(
              CREATE_BANK_ACCOUNT,
              { input: values }
            )
            errors = data.createAccBankAccount.errors
          } else {
            const data = await gqlFetch<{ updateAccBankAccount: { errors: { message: string }[] | null } }>(
              UPDATE_BANK_ACCOUNT,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateAccBankAccount.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '银行账户已创建' : '银行账户已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBankAccounts'] })
        }}
      />
    </>
  )
}
