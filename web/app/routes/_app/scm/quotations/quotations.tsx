import { createFileRoute } from '@tanstack/react-router'
import { Chip } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import {
  AUDIT_DOC_ACTION_VISIBLE,
  AUDIT_DOC_STATUS_ENUM_COLORS,
} from '~/lib/doc-status'
import { todayLocal } from '~/lib/form-defaults'
import { useAuditDoc } from '../-audit-doc'
import { salesQuotationAuditConfig, useQuotationDrawer } from './-quotation-drawer'

export const Route = createFileRoute('/_app/scm/quotations/quotations')({
  component: QuotationsTab,
})

/** 已过期是派生展示态:已审核 且 截止日 < 今天(截止当日仍有效),不落库 */
export function isExpired(status: unknown, validUntil: unknown): boolean {
  return status === 'AUDITED' && validUntil != null && String(validUntil) < todayLocal()
}

// 状态胶囊配色:草稿灰、已审核绿、已作废红;过期(派生态)黄,盖过已审核展示
const GRID_OVERRIDES = {
  // 卡片:单号标题、客户副标题、日期/状态/截止摘要
  companyId: { mobileRole: 'hide' },
  quotationNo: { mobileRole: 'title' },
  partyId: { mobileRole: 'subtitle' },
  partyType: { label: '对手类型', mobileRole: 'hide' },
  quotationDate: { mobileRole: 'summary' },
  currencyId: { label: '币种' },
  validUntil: { label: '报价截止', mobileRole: 'summary' },
  status: {
    mobileRole: 'summary',
    enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
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
const ACTION_VISIBLE = AUDIT_DOC_ACTION_VISIBLE

function QuotationsTab() {
  const openDrawer = useQuotationDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(salesQuotationAuditConfig)

  return (
    <>
      <SynieDataGrid
        resource="salQuotations"
        columns={GRID_COLUMNS}
        overrides={GRID_OVERRIDES}
        onView={(row) => openDrawer('view', row)}
        onCreate={() => openDrawer('create', null)}
        onEdit={(row) => openDrawer(row.status === 'DRAFT' ? 'edit' : 'view', row)}
        // 审核改走「列出全部条目核对」的确认弹窗(与条目页「审核整单」同一套)
        actionHandlers={{ audit: (rows, ctx) => requestAudit(String(rows[0].id), ctx.refetch) }}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
