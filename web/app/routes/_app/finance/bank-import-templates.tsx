import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/bank-import-templates')({
  component: BankImportTemplatesPage,
})

const CREATE_TEMPLATE = `
  mutation ($input: CreateAccBankImportTemplateInput!) {
    createAccBankImportTemplate(input: $input) { result { id } errors { message } }
  }
`
const UPDATE_TEMPLATE = `
  mutation ($id: ID!, $input: UpdateAccBankImportTemplateInput!) {
    updateAccBankImportTemplate(id: $id, input: $input) { result { id } errors { message } }
  }
`

// 概览列;列配置细节抽屉里看(有序白名单,兼当 exclude)
const GRID_COLUMNS = ['companyId', 'name', 'bankAccountId', 'startRow', 'datetimeCol', 'dateCol', 'amountCol']

function BankImportTemplatesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">流水导入模板</h1>
      <p className="mt-2 text-sm text-ink-500">
        描述银行导出 xls/xlsx 的列布局(各字段在哪一列、日期格式、起始行),导入银行流水时按模板解析。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource="accBankImportTemplates"
          columns={GRID_COLUMNS}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
        />
      </div>

      <SynieRecordDrawer
        resource="accBankImportTemplates"
        label="导入模板"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无各列号明细),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        fields={{
          // 公司提到最前(账户候选依赖它);建后不可改;换公司时清掉已选账户
          companyId: { required: true, order: -1, edit: 'createOnly', effects: () => ({ bankAccountId: null }) },
          name: { order: 1, required: true, placeholder: '如 招行专业版对账单' },
          bankAccountId: {
            order: 2,
            cols: 6,
            required: true,
            input: ({ value, onChange, isDisabled, values }) => {
              const companyId = (values.companyId ?? null) as string | null
              return (
                <RemoteSelect
                  resource="accBankAccounts"
                  label="银行账户"
                  // 直连资源(非 fk ref 反射),显示字段须显式给 alias(缺省 name 拼出非法查询)
                  labelField="alias"
                  searchFields={['alias', 'accountNo']}
                  placeholder={companyId ? '选择账户…' : '先选择公司'}
                  value={value == null ? null : String(value)}
                  onChange={(id) => onChange(id)}
                  isDisabled={isDisabled || companyId == null}
                  filter={`{companyId: {eq: ${JSON.stringify(companyId)}}}`}
                />
              )
            },
          },
          startRow: { order: 3, cols: 6, required: true, defaultValue: 2, placeholder: '数据首行,1 起数' },
          // 时间配置二选一:填日期时间列(单列)或日期列(双列,时间列可省);格式是枚举下拉
          datetimeCol: { order: 4, cols: 6, placeholder: '如 A;与日期/时间列二选一' },
          datetimeFormat: { order: 5, cols: 6 },
          dateCol: { order: 6, cols: 6, placeholder: '如 A;与日期时间列二选一' },
          dateFormat: { order: 7, cols: 6 },
          timeCol: { order: 8, cols: 6, placeholder: '可空,缺省按 00:00:00' },
          timeFormat: { order: 9, cols: 6 },
          // 金额配置二选一:收/支双列,或带符号单列
          incomeCol: { order: 10, cols: 6, placeholder: '如 C;与金额列互斥' },
          expenseCol: { order: 11, cols: 6, placeholder: '如 D;与金额列互斥' },
          amountCol: { order: 12, cols: 6, placeholder: '带符号:正=收入、负=支出' },
          balanceCol: { order: 13, cols: 6, placeholder: '如 E' },
          counterpartyNameCol: { order: 14, cols: 6, placeholder: '如 F' },
          counterpartyAccountCol: { order: 15, cols: 6, placeholder: '如 G' },
          summaryCol: { order: 16, cols: 6, placeholder: '如 H' },
          noteCol: { order: 17, cols: 6, placeholder: '如 I' },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          let errors: { message: string }[] | null
          if (mode === 'create') {
            const data = await gqlFetch<{ createAccBankImportTemplate: { errors: { message: string }[] | null } }>(
              CREATE_TEMPLATE,
              { input: values }
            )
            errors = data.createAccBankImportTemplate.errors
          } else {
            const data = await gqlFetch<{ updateAccBankImportTemplate: { errors: { message: string }[] | null } }>(
              UPDATE_TEMPLATE,
              { id: drawer!.row!.id, input: values }
            )
            errors = data.updateAccBankImportTemplate.errors
          }
          if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '))
          toast.success(mode === 'create' ? '导入模板已创建' : '导入模板已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBankImportTemplates'] })
        }}
      />
    </>
  )
}
