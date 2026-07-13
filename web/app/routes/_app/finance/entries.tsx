import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid } from '~/components/synie-data-grid/SynieDataGrid'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import type { Row } from '~/components/synie-data-grid/types'

export const Route = createFileRoute('/_app/finance/entries')({
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

function EntriesPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">总账分录</h1>
      <p className="mt-2 text-sm text-ink-500">总账分录明细,来源单据审核后自动生成,只读不可编辑。</p>

      <div className="mt-6">
        <SynieDataGrid resource="accGlEntries" columns={GRID_COLUMNS} onView={(row) => setViewRow(row)} />
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
