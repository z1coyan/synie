import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { formatAmount } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/acceptance/holdings')({
  component: BillHoldingsPage,
})

// billNo 不进表格:billId 已 fk 链接到票据(labelField=billNo),再列一次是冗余(同 entries.tsx
// voucherNo 先例);金额/到期日/取得日/来源交易紧随票据段(子票起止)之后,来源交易 fk 链接为
// GridMeta 反射默认(belongs_to → fk 列)
const GRID_COLUMNS = [
  'companyId',
  'bankAccountId',
  'billId',
  'subStart',
  'subEnd',
  'amount',
  'dueDate',
  'acquiredOn',
  'sourceTransactionId',
]

const GRID_OVERRIDES = {
  amount: { render: (v: unknown) => formatAmount(v) },
} satisfies Record<string, ColumnOverride>

function BillHoldingsPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)

  return (
    <>
      <p className="text-sm text-ink-500">
        各银行账户当前持有的承兑票据段快照,由承兑交易审核后自动重放生成,只读不可编辑。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="accBillHoldings"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'dueDate', direction: 'ascending' }}
          onView={(row) => setViewRow(row)}
          pageSummary={(rows) => (
            <span>
              本页合计:¥{formatAmount(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0))} / {rows.length} 段
            </span>
          )}
        />
      </div>

      <SynieRecordDrawer
        resource="accBillHoldings"
        label="持有承兑"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        row={viewRow}
        // billNo/insertedAt 表格未取、行数据不带(只会显示占位);billId fk 链接已表意票号
        exclude={['billNo', 'insertedAt']}
      />
    </>
  )
}
