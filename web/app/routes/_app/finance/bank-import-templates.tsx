import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import {
  useCatalogBasicForm,
  requireWriter,
} from '~/lib/resources/catalog'
import { ensureDefaultGridPage } from '~/lib/route-prefetch'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'

export const Route = createFileRoute('/_app/finance/bank-import-templates')({
  loader: ({ context: { queryClient } }) =>
    ensureDefaultGridPage(queryClient, RESOURCE),
  component: BankImportTemplatesPage,
})

const RESOURCE = 'accBankImportTemplates'

// 概览列;列配置细节抽屉里看(有序白名单,兼当 exclude)
const GRID_COLUMNS = ['companyId', 'name', 'bankAccountId', 'startRow', 'datetimeCol', 'dateCol', 'amountCol']

function BankImportTemplatesPage() {
  const { drawer, open, setMode, close } = useRecordDrawerUrl(RESOURCE)
  const queryClient = useQueryClient()
  const { binding, formProps } = useCatalogBasicForm(RESOURCE, '导入模板')

  return (
    <>
      <h1 className="font-brand text-xl">流水导入模板</h1>
      <p className="mt-1 text-xs text-ink-500">
        描述银行导出 xls/xlsx 的列布局(各字段在哪一列、日期格式、起始行),导入银行流水时按模板解析。
      </p>

      <div className="mt-6">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          onView={(row) => open('view', String(row.id))}
          onCreate={() => open('create')}
          onEdit={(row) => open('edit', String(row.id))}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label={formProps.label}
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        // 表格列是白名单子集(无各列号明细),行数据不全;走 rowId 自查完整记录
        rowId={drawer?.recordId ?? undefined}
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
        onEdit={() => setMode('edit')}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await requireWriter(binding, 'create', '导入模板')(values)
          } else {
            await requireWriter(binding, 'update', '导入模板')(String(drawer!.recordId), values)
          }
          toast.success(mode === 'create' ? '导入模板已创建' : '导入模板已更新')
          await binding.cache.invalidateGrid(queryClient)
        }}
      />
    </>
  )
}
