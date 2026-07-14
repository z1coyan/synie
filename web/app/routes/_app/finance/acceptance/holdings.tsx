import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { gqlFetch } from '~/lib/graphql'
import { formatAmount } from '~/lib/amount'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/registry'
import type { Row, RowAction } from '~/components/synie-data-grid/types'
import {
  AcceptanceTransactionDrawer,
  TX_TYPE_LABEL,
  type TransactionDrawerState,
  type TxType,
} from './-transaction-drawer'

export const Route = createFileRoute('/_app/finance/acceptance/holdings')({
  component: BillHoldingsPage,
})

const UPDATE_BILL = `
  mutation ($id: ID!, $input: UpdateAccBillInput!) {
    updateAccBill(id: $id, input: $input) { result { id } errors { message } }
  }
`

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

// 持有段行内可发起的后续交易(接收之外的四类都基于已有承兑,入口收在这里)
const HOLDING_TX_TYPES: TxType[] = ['ENDORSE', 'SETTLE', 'DISCOUNT', 'REALLOCATE']

function BillHoldingsPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)
  const [txDrawer, setTxDrawer] = useState<TransactionDrawerState | null>(null)
  // 票面修正:持有段行 → 票据主档 edit 抽屉(建档随接收交易完成,需要更正票面的票必然还在持有中)
  const [billEdit, setBillEdit] = useState<{ billId: string } | null>(null)
  const queryClient = useQueryClient()

  // 行操作跨资源写数据,门控按目标资源的能力反射:发起交易看 accBillTransactions:create,
  // 票面修正看 accBills:update(挂在持有 meta 的 capability 字段上会查错资源,fail-closed 隐藏)
  const txMeta = useGridMeta('accBillTransactions')
  const billMeta = useGridMeta('accBills')
  const canCreateTx = (txMeta.data?.capabilities ?? []).includes('create')
  const canEditBill = (billMeta.data?.capabilities ?? []).includes('update')

  const rowActions: RowAction[] = [
    ...(canCreateTx
      ? HOLDING_TX_TYPES.map((txType) => ({
          key: `tx:${txType}`,
          label: TX_TYPE_LABEL[txType],
          onAction: (row: Row) => setTxDrawer({ mode: 'create', txType, holding: row }),
        }))
      : []),
    ...(canEditBill
      ? [
          {
            key: 'billEdit',
            label: '票面修正',
            onAction: (row: Row) => setBillEdit({ billId: String(row.billId) }),
          },
        ]
      : []),
  ]

  const invalidateAcceptance = () => {
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillTransactions'] })
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillHoldings'] })
    queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBills'] })
  }

  return (
    <>
      <p className="text-sm text-ink-500">
        各银行账户当前持有的承兑票据段快照,由承兑交易审核后自动重放生成;转让、兑付、贴现、调拨从行内对该段发起。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource="accBillHoldings"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'dueDate', direction: 'ascending' }}
          onView={(row) => setViewRow(row)}
          rowActions={rowActions}
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

      <AcceptanceTransactionDrawer state={txDrawer} onStateChange={setTxDrawer} onMutated={invalidateAcceptance} />

      <SynieRecordDrawer
        {...drawerConfig('accBills')}
        resource="accBills"
        mode="edit"
        isOpen={billEdit !== null}
        onOpenChange={(open) => !open && setBillEdit(null)}
        rowId={billEdit?.billId}
        onSubmit={async (values) => {
          const data = await gqlFetch<{ updateAccBill: { errors: { message: string }[] | null } }>(UPDATE_BILL, {
            id: billEdit!.billId,
            input: values,
          })
          if (data.updateAccBill.errors && data.updateAccBill.errors.length > 0) {
            throw new Error(data.updateAccBill.errors.map((e) => e.message).join('; '))
          }
          toast.success('票据已更新')
          // 持有段冗余票号/到期日取自票据主档,一并失效
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBills'] })
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBillHoldings'] })
        }}
      />
    </>
  )
}
