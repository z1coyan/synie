import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { FilterState, Row } from '~/components/synie-data-grid/types'

// 应收应付报表下钻参数:预置列筛选打开本页(全部可选,普通访问不带)
interface EntriesSearch {
  companyId?: string
  companyLabel?: string
  partyType?: string
  partyId?: string
  partyLabel?: string
  /** 报表「未指定对手」行下钻:仅看无对手分录 */
  partyNil?: boolean
  accountIds?: string[]
  accountLabels?: string[]
  asOf?: string
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const strArr = (v: unknown) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined

export const Route = createFileRoute('/_app/finance/entries')({
  validateSearch: (search: Record<string, unknown>): EntriesSearch => ({
    companyId: str(search.companyId),
    companyLabel: str(search.companyLabel),
    partyType: str(search.partyType),
    partyId: str(search.partyId),
    partyLabel: str(search.partyLabel),
    partyNil: search.partyNil === true || undefined,
    accountIds: strArr(search.accountIds),
    accountLabels: strArr(search.accountLabels),
    asOf: str(search.asOf),
  }),
  component: EntriesPage,
})

// 公司放首列;voucherId 多态 fk 链接列(文本=凭证号,点击开来源单据速览),紧跟着的
// isReversed/isReversal 是红冲标记(该分录是否已被红冲/是否为红冲分录本身);
// 冗余的 voucherNo/voucherType 字符串列与创建/更新时间不进表格(有序白名单)
const GRID_COLUMNS = [
  'companyId',
  'postingDate',
  'voucherId',
  'isReversed',
  'isReversal',
  'accountId',
  'debit',
  'credit',
  'partyType',
  'partyId',
  'currencyId',
  'seq',
  'isCancelled',
  'remarks',
]

// 下钻参数 → 初始列筛选(与报表同口径:截至日、未作废);进的是普通筛选状态,用户可改可清
function drillFilters(s: EntriesSearch): FilterState {
  const filters: FilterState = {}
  if (s.companyId)
    filters.companyId = { kind: 'fk', values: [s.companyId], labels: [s.companyLabel ?? s.companyId] }
  if (s.accountIds)
    filters.accountId = { kind: 'fk', values: s.accountIds, labels: s.accountLabels ?? s.accountIds }
  if (s.partyNil) filters.partyId = { kind: 'polyFk', op: 'isNil' }
  else if (s.partyType && s.partyId)
    filters.partyId = {
      kind: 'polyFk',
      op: 'in',
      variant: s.partyType,
      values: [s.partyId],
      labels: [s.partyLabel ?? s.partyId],
    }
  if (s.asOf) {
    filters.postingDate = { kind: 'date', op: 'between', lte: s.asOf }
    filters.isCancelled = { kind: 'bool', eq: false }
  }
  return filters
}

function EntriesPage() {
  const search = Route.useSearch()
  const [viewRow, setViewRow] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">总账分录</h1>
      <p className="mt-2 text-sm text-ink-500">总账分录明细,来源单据审核后自动生成,只读不可编辑。</p>

      <div className="mt-6">
        {/* key 随下钻参数重挂:defaultFilters 仅作初值,报表再次跳转要换新条件 */}
        <SynieDataGrid
          key={JSON.stringify(search)}
          resource="accGlEntries"
          columns={GRID_COLUMNS}
          defaultFilters={drillFilters(search)}
          onView={(row) => setViewRow(row)}
        />
      </div>

      <SynieRecordDrawer
        resource="accGlEntries"
        label="分录"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        row={viewRow}
        // voucherNo/时间列表格未取、行数据不带(只会显示占位);voucherType 原始类型码,来源单据链接已表意
        exclude={['voucherNo', 'voucherType', 'insertedAt', 'updatedAt']}
      />
    </>
  )
}
