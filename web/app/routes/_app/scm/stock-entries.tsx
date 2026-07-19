import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'

export const Route = createFileRoute('/_app/scm/stock-entries')({
  component: StockEntriesPage,
})

/**
 * 库存分录流水(ADR 2026-07-19-stock-ledger):库存领域唯一事实表,只追加不可改,
 * 由来源单据(手工出入库单/手工调拨单)审核时派生;作废不删行,仅标记 isCancelled。
 * 数量带符号(入正出负,物料默认单位口径)。页面只读:公司首列可筛(对齐总账分录),
 * 常规列筛选 + 来源单据多态链接列;无顶部全局公司选择器。
 */

// 列白名单:公司首列(对齐总账分录);seq/时间戳不进表格
const GRID_COLUMNS = [
  'companyId',
  'postingDate',
  'warehouseId',
  'materialId',
  'quantity',
  'voucherId',
  'voucherNo',
  'remarks',
  'isCancelled',
]

// 数量带符号:入库正数、出库负数(红字);空值回落默认渲染
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  quantity: {
    render: (v) => {
      if (v == null || v === '') return undefined
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      return <span className={n < 0 ? 'text-danger' : undefined}>{n}</span>
    },
  },
  voucherNo: { label: '来源单号' },
  remarks: { label: '摘要', width: 240 },
}

function StockEntriesPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">库存分录流水</h1>
      <p className="mt-2 text-sm text-ink-500">
        库存分录明细,来源单据审核后自动生成,只读不可编辑;数量入正出负,来源单据可点开速览。
      </p>

      <div className="mt-6">
        {/* 分录只读:不传 onCreate/onEdit 即无新增/编辑入口;来源单据是多态 fk 链接列(GridMeta poly_refs 反射) */}
        <SynieDataGrid
          resource="invStockEntries"
          columns={GRID_COLUMNS}
          overrides={GRID_OVERRIDES}
          defaultSort={{ column: 'postingDate', direction: 'descending' }}
          onView={setViewRow}
        />
      </div>

      <SynieRecordDrawer
        resource="invStockEntries"
        label="库存分录"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        row={viewRow}
        // voucherType 原始类型码,来源单据链接已表意
        exclude={['voucherType', 'insertedAt']}
      />
    </>
  )
}
