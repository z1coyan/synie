import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { Row } from '~/components/synie-data-grid/types'
import { useCatalogBasicForm,
  requireWriter,} from '~/lib/resources/catalog'

export const Route = createFileRoute('/_app/finance/bank-import-templates')({
  component: BankImportTemplatesPage,
})

// 概览列;列配置细节抽屉里看(有序白名单,兼当 exclude)
const GRID_COLUMNS = ['companyId', 'name', 'bankAccountId', 'startRow', 'datetimeCol', 'dateCol', 'amountCol']

function BankImportTemplatesPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(
    'accBankImportTemplates',
    '导入模板',
  )

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
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无各列号明细),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        exclude={formProps.exclude}
        fields={{
          ...formProps.fields,
          // 公司提到最前(账户候选依赖它);建后不可改;换公司时清掉已选账户
          companyId: {
            ...formProps.fields.companyId,
            effects: () => ({ bankAccountId: null }),
          },
          bankAccountId: {
            ...formProps.fields.bankAccountId,
            input: ({ value, onChange, isDisabled, values }) => {
              const companyId = (values.companyId ?? null) as string | null
              return (
                <RemoteSelect
                  resource="accBankAccounts"
                  label="银行账户"
                  // 直连资源（非 fk ref 反射），显示字段须显式使用 alias。
                  labelField="alias"
                  searchFields={['alias', 'accountNo']}
                  placeholder={companyId ? '选择账户…' : '先选择公司'}
                  value={value == null ? null : String(value)}
                  onChange={(id) => onChange(id)}
                  isDisabled={isDisabled || companyId == null}
                  filterState={{ companyId: { kind: 'fk', values: [companyId!], labels: [] } }}
                />
              )
            },
          },
        }}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await requireWriter(binding, 'create', '导入模板')(values)
          } else {
            await requireWriter(binding, 'update', '导入模板')(drawer!.row!.id, values)
          }
          toast.success(mode === 'create' ? '导入模板已创建' : '导入模板已更新')
          await binding.cache.invalidateGrid(queryClient)
        }}
      />
    </>
  )
}
