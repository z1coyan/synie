import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@heroui/react'
import { formatAmount } from '~/lib/amount'
import { SynieAttachmentPanel } from '~/components/synie-attachment-panel/SynieAttachmentPanel'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { DrawerMode } from '~/components/synie-record-drawer/fields'
import type { ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { bankTransactionClient } from '~/lib/resources/finance-operations'
import { resourceBindingFor } from '~/lib/resources/registry'
import { FinanceBankImportDrawers } from './-bank-import-drawers'
import { FinanceReconcileDrawer } from './-reconcile-drawer'

export const Route = createFileRoute('/_app/finance/bank-transactions')({
  component: BankTransactionsPage,
})

// 列序对齐银行流水单心智:身份(公司/账户)→ 时间 → 交易内容(摘要/对方)→ 金额(收/支)
// → 对账扩展区(状态/未对账)收尾。余额是银行口径快照(常空、扫读噪音)不进表格,
// 详情「查看」抽屉仍可见;对方账号/备注/时间戳同理(有序白名单,兼当 exclude)
const GRID_COLUMNS = [
  'companyId',
  'bankAccountId',
  'occurredAt',
  'summary',
  'counterpartyName',
  'income',
  'expense',
  'reconcileStatus',
  'unreconciledAmount',
]

// 金额列降噪:列头去「金额」后缀、千分位;方向由列头表达故不加正负号,收入以绿色示向;
// 未对账为 0(已对完)弱化、有余额保持前景色。render 返回 null 回落 defaultCell,空值仍出「—」
// 卡片:摘要标题、对方户名副标题、时间/收支/对账状态摘要(流水手机速查)
const GRID_OVERRIDES = {
  companyId: { mobileRole: 'hide' },
  summary: { mobileRole: 'title' },
  // 交易时间到分即可(秒进详情看),长户名截断到 120px(点击弹全文),给金额与对账列留视口
  occurredAt: {
    mobileRole: 'summary',
    render: (v) =>
      v == null || v === ''
        ? null
        : new Date(String(v)).toLocaleString('zh-CN', {
            hour12: false,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
  },
  counterpartyName: { width: 80, mobileRole: 'subtitle' },
  income: {
    label: '收入',
    render: (v) => (v == null || v === '' ? null : <span className="text-success">{formatAmount(v)}</span>),
  },
  expense: {
    label: '支出',
    render: (v) => (v == null || v === '' ? null : formatAmount(v)),
  },
  reconcileStatus: {
    // 对账状态三态胶囊:未对账红、部分对账橙、已对账绿
    mobileRole: 'summary',
    enumColors: { UNRECONCILED: 'danger', PARTIAL: 'warning', RECONCILED: 'success' },
  },
  unreconciledAmount: {
    label: '未对账',
    mobileRole: 'summary',
    render: (v) =>
      v == null || v === '' ? null : Number(v) > 0 ? (
        formatAmount(v)
      ) : (
        <span className="text-muted">{formatAmount(v)}</span>
      ),
  },
} satisfies Record<string, ColumnOverride>

function BankTransactionsPage() {
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; row: Row | null } | null>(null)
  const [reconcileTxn, setReconcileTxn] = useState<Row | null>(null)
  const queryClient = useQueryClient()
  // 语义 command key=reconcile（非 export）；row target 在打开抽屉前校验
  const binding = resourceBindingFor('accBankTransactions')

  // 导入三件套:新增导入 / 导入记录(解析结果与执行)/ 导入历史;historyKey 让历史列表跟着变更刷新
  const [importCreateOpen, setImportCreateOpen] = useState(false)
  const [importRecordId, setImportRecordId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">银行流水</h1>
      <p className="mt-2 text-sm text-ink-500">银行对账单的电子档案:数据以银行为准,余额是银行口径快照。</p>

      <div className="mt-6">
        <SynieDataGrid
          resource="accBankTransactions"
          client={bankTransactionClient}
          columns={GRID_COLUMNS}
          attachmentImages={{ ownerType: 'acc_bank_transaction', label: '回单' }}
          defaultSort={{ column: 'occurredAt', direction: 'descending' }}
          onView={(row) => setDrawer({ mode: 'view', row })}
          onCreate={() => setDrawer({ mode: 'create', row: null })}
          onEdit={(row) => setDrawer({ mode: 'edit', row })}
          importMenu={[
            { key: 'history', label: '导入历史', onAction: () => setHistoryOpen(true) },
            { key: 'new', label: '新增导入', onAction: () => setImportCreateOpen(true) },
          ]}
          overrides={GRID_OVERRIDES}
          rowActions={[
            {
              key: 'reconcile',
              label: '对账',
              capability: 'reconcile',
              onAction: (row) => {
                // row command：在打开抽屉前校验 target 恰好一个 id
                if (!binding.commands) throw new Error('银行流水未绑定 reconcile 命令')
                const id = String(row.id ?? '')
                if (!id) throw new Error('对账需要恰好一个流水 id')
                setReconcileTxn(row)
              },
            },
          ]}
        />
      </div>

      <FinanceBankImportDrawers
        createOpen={importCreateOpen}
        onCreateOpenChange={setImportCreateOpen}
        historyOpen={historyOpen}
        onHistoryOpenChange={setHistoryOpen}
        historyKey={historyKey}
        importId={importRecordId}
        onImportIdChange={setImportRecordId}
        onChanged={() => {
          setHistoryKey((key) => key + 1)
          queryClient.invalidateQueries({
            queryKey: ['gridRows', 'accBankTransactions'],
          })
        }}
      />

      <SynieRecordDrawer
        resource="accBankTransactions"
        client={bankTransactionClient}
        label="银行流水"
        mode={drawer?.mode ?? 'view'}
        isOpen={drawer !== null}
        onOpenChange={(open) => !open && setDrawer(null)}
        // 表格列是白名单子集(无对方账号/备注),行数据不全;不传 row,走 rowId 自查完整记录
        rowId={drawer?.row?.id}
        // 派生列是系统维护字段,不进表单;view 态在对账抽屉里看
        exclude={['reconcileStatus', 'reconciledAmount', 'unreconciledAmount']}
        fields={{
          // 公司提到最前(账户候选依赖它);建后不可改(update 动作不收 company_id);
          // 换公司时清掉已选账户,避免跨公司账户挂错
          companyId: { required: true, order: -1, edit: 'createOnly', effects: () => ({ bankAccountId: null }) },
          bankAccountId: {
            order: 1,
            required: true,
            // 候选限定在所选公司的启用账户(后端另有同公司/停用校验兜底)
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
                  filterState={{
                    companyId: { kind: 'fk', values: [companyId!], labels: [] },
                    active: { kind: 'bool', eq: true },
                  }}
                />
              )
            },
          },
          occurredAt: { order: 2, required: true },
          // 收入/支出恰填一项:一侧填入非零值即清空另一侧(后端校验兜底)
          income: {
            order: 3,
            cols: 6,
            placeholder: '与支出二填一',
            effects: (v) => (v ? { expense: null } : undefined),
          },
          expense: {
            order: 4,
            cols: 6,
            placeholder: '与收入二填一',
            effects: (v) => (v ? { income: null } : undefined),
          },
          balance: { order: 5, placeholder: '银行口径余额快照,可空' },
          counterpartyName: { order: 6, cols: 6, placeholder: '如 某某公司' },
          counterpartyAccount: { order: 7, cols: 6, placeholder: '对方账号/卡号' },
          summary: { order: 8, placeholder: '银行摘要/用途,如 货款' },
          note: { order: 9, placeholder: '内部备注' },
        }}
        extraContent={(mode, row) => (
          <SynieAttachmentPanel
            ownerType="acc_bank_transaction"
            ownerId={row?.id as string | undefined}
            readonly={mode === 'view'}
          />
        )}
        onEdit={() => setDrawer((d) => (d ? { ...d, mode: 'edit' } : d))}
        onSubmit={async (values, mode) => {
          if (mode === 'create') {
            await bankTransactionClient.create(values)
          } else {
            await bankTransactionClient.update(drawer!.row!.id, values)
          }
          toast.success(mode === 'create' ? '银行流水已登记' : '银行流水已更新')
          queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBankTransactions'] })
        }}
      />

      <FinanceReconcileDrawer
        txn={reconcileTxn}
        onOpenChange={(open) => !open && setReconcileTxn(null)}
        // 对账增删改变派生列:失效列表查询即可,分页/筛选状态得以保留(main 的 query 失效范式)
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['gridRows', 'accBankTransactions'] })}
      />
    </>
  )
}
