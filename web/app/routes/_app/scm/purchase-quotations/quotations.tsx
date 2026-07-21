import { createFileRoute } from '@tanstack/react-router'
import { Chip } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useQuotationDrawer } from './-quotation-drawer'

export const Route = createFileRoute('/_app/scm/purchase-quotations/quotations')({
  component: QuotationsTab,
})

// 本地日期 YYYY-MM-DD(与 date 列字面量直接字典序比较)
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 已过期是派生展示态:已审核 且 截止日 < 今天(截止当日仍有效),不落库 */
export function isExpired(status: unknown, validUntil: unknown): boolean {
  return status === 'AUDITED' && validUntil != null && String(validUntil) < todayLocal()
}

// 状态胶囊配色:草稿灰、已审核绿、已作废红;过期(派生态)黄,盖过已审核展示
const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  currencyId: { label: '币种' },
  validUntil: { label: '报价截止' },
  status: {
    enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' },
    render: (v: unknown, row: Row) =>
      isExpired(v, row.validUntil) ? (
        <Chip size="sm" className="whitespace-nowrap" color="warning">
          已过期
        </Chip>
      ) : undefined,
  },
} satisfies Record<string, ColumnOverride>

// 常用列白名单:时间戳/审核人/录入人不进表格(兼当 exclude)
const GRID_COLUMNS = [
  'companyId',
  'quotationNo',
  'quotationDate',
  'validUntil',
  'partyType',
  'partyId',
  'currencyId',
  'status',
]

// 状态机动作显隐:审核/删除仅草稿,作废仅已审核(含已过期;后端权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  audit: (row: Row) => row.status === 'DRAFT',
  void: (row: Row) => row.status === 'AUDITED',
  delete: (row: Row) => row.status === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

function QuotationsTab() {
  const openDrawer = useQuotationDrawer()

  return (
    <SynieDataGrid
      resource="purQuotations"
      columns={GRID_COLUMNS}
      overrides={GRID_OVERRIDES}
      onView={(row) => openDrawer('view', row)}
      onCreate={() => openDrawer('create', null)}
      onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
      actionVisible={ACTION_VISIBLE}
    />
  )
}
