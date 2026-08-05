import { hasCapability } from '@synie/shared'
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { drawerConfig } from '~/components/synie-record-drawer/extension-drawer-props'
import type { Row, RowAction } from '~/components/synie-data-grid/types'
import {
  billClient,
} from '~/lib/resources/finance-operations'
import { resourceBindingFor } from '~/lib/resources/registry'
import { useRecordDrawerUrl } from '~/lib/use-record-drawer-url'
import {
  AcceptanceTransactionDrawer,
  TX_TYPE_LABEL,
  type TransactionDrawerState,
  type TxType,
} from './-transaction-drawer'

const RESOURCE = 'accBillHoldings'

export const Route = createFileRoute('/_app/finance/acceptance/holdings')({
  // defaultSort 与默认首屏 key 不一致,跳过 loader 预取
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
  // 卡片:票号标题、银行账户副标题、金额/到期日/取得日摘要
  companyId: { mobileRole: 'hide' },
  billId: { mobileRole: 'title' },
  bankAccountId: { mobileRole: 'subtitle' },
  amount: { mobileRole: 'summary', render: (v: unknown) => formatAmount(v) },
  // meta description 即列头,括号说明进表格太啰嗦,收敛为短名
  dueDate: { label: '到期日', mobileRole: 'summary' },
  acquiredOn: { mobileRole: 'summary' },
  sourceTransactionId: { label: '来源交易' },
} satisfies Record<string, ColumnOverride>

// 持有段行内可发起的后续交易(接收之外的四类都基于已有承兑,入口收在这里)
const HOLDING_TX_TYPES: TxType[] = ['ENDORSE', 'SETTLE', 'DISCOUNT', 'REALLOCATE']

function BillHoldingsPage() {
  // 持有段查看主抽屉 URL 化;发起交易/票面修正二级抽屉保持本地(不写 record URL)
  const { drawer, open, close } = useRecordDrawerUrl(RESOURCE)
  const [txDrawer, setTxDrawer] = useState<TransactionDrawerState | null>(null)
  // 票面修正:持有段行 → 票据主档 edit 抽屉(建档随接收交易完成,需要更正票面的票必然还在持有中)
  const [billEdit, setBillEdit] = useState<{ billId: string } | null>(null)
  const queryClient = useQueryClient()

  // 行操作跨资源写数据,门控按目标资源的能力反射:发起交易看 accBillTransactions:create,
  // 票面修正看 accBills:update(挂在持有 meta 的 capability 字段上会查错资源,fail-closed 隐藏)
  const txMeta = useGridMeta('accBillTransactions', true)
  const billMeta = useGridMeta('accBills', true)
  const canCreateTx = hasCapability(txMeta.data?.capabilities ?? [], 'create')
  const canEditBill = hasCapability(billMeta.data?.capabilities ?? [], 'update')

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
    void resourceBindingFor('accBillTransactions').cache.invalidateGrid(queryClient)
    void resourceBindingFor(RESOURCE).cache.invalidateGrid(queryClient)
    void resourceBindingFor('accBills').cache.invalidateGrid(queryClient)
  }

  return (
    <>
      <p className="text-sm text-ink-500">
        各银行账户当前持有的承兑票据段快照,由承兑交易审核后自动重放生成;转让、兑付、贴现、调拨从行内对该段发起。
      </p>

      <div className="mt-4">
        <SynieDataGrid
          resource={RESOURCE}
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'dueDate', direction: 'ascending' }}
          onView={(row) => open('view', String(row.id))}
          rowActions={rowActions}
          pageSummary={(rows) => (
            <span>
              本页合计:¥{formatAmount(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0))} / {rows.length} 段
            </span>
          )}
        />
      </div>

      <SynieRecordDrawer
        resource={RESOURCE}
        label="持有承兑"
        mode="view"
        isOpen={drawer !== null}
        onOpenChange={(isOpen) => !isOpen && close()}
        // 表格列是白名单子集,行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.recordId ?? undefined}
        // billNo/insertedAt 表格未取、行数据不带(只会显示占位);billId fk 链接已表意票号
        exclude={['billNo', 'insertedAt']}
      />

      {/* 发起转让/兑付/贴现/调拨:二级创建抽屉,保持本地(urlSync 默认 false 语义) */}
      <AcceptanceTransactionDrawer state={txDrawer} onStateChange={setTxDrawer} onMutated={invalidateAcceptance} />

      {/* 票面修正:二级编辑抽屉,保持本地 */}
      <SynieRecordDrawer
        {...drawerConfig('accBills')}
        resource="accBills"
        mode="edit"
        isOpen={billEdit !== null}
        onOpenChange={(isOpen) => !isOpen && setBillEdit(null)}
        rowId={billEdit?.billId}
        onSubmit={async (values) => {
          await billClient.update(billEdit!.billId, values)
          toast.success('票据已更新')
          // 持有段冗余票号/到期日取自票据主档,一并失效
          await Promise.all([
            resourceBindingFor('accBills').cache.invalidateGrid(queryClient),
            resourceBindingFor(RESOURCE).cache.invalidateGrid(queryClient),
          ])
        }}
      />
    </>
  )
}
