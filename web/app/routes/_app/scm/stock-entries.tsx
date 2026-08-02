import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { dateOnlyText } from '~/components/synie-data-grid/format'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'

export const Route = createFileRoute('/_app/scm/stock-entries')({
  component: StockEntriesPage,
})

/**
 * 库存分录流水(ADR 2026-07-19-stock-ledger):库存领域唯一事实表,只追加不可改,
 * 由来源单据审核时派生;作废不删行,仅标记 isCancelled。
 * 数量带符号(入正出负,物料默认单位口径)。页面只读:公司首列可筛(对齐总账分录),
 * 常规列筛选 + 来源单据多态链接列;无顶部全局公司选择器。
 */

// 列白名单:公司首列(对齐总账分录);seq/时间戳不进表格;
// voucherId 多态 fk 链接列(文本=来源单号,点击开来源单据速览),冗余的 voucherNo/voucherType
// 字符串列不进表格(同总账分录先例);
// 物料按全站约定合并为单个富单元格列(materialCode 列承载,分录无快照,后端 join 物料主数据投影)
const GRID_COLUMNS = [
  'companyId',
  'postingDate',
  'warehouseId',
  'materialCode',
  'quantity',
  'voucherId',
  'remarks',
  'isCancelled',
]

// 数量带符号:入库正数、出库负数(红字);空值回落默认渲染
// 卡片:物料标题、业务日副标题、数量/仓/来源单据摘要
const GRID_OVERRIDES: Record<string, ColumnOverride> = {
  companyId: { mobileRole: 'hide' },
  // 物料列:全站统一富单元格(分录无图纸挂接,缩略图回退物料当前图纸);筛选按 materialId 外键
  materialCode: {
    label: '物料',
    mobileRole: 'title',
    filterField: 'materialId',
    render: materialCellRender(),
  },
  postingDate: {
    mobileRole: 'subtitle',
    render: (value) => dateOnlyText(value) || undefined,
  },
  quantity: {
    mobileRole: 'summary',
    render: (v) => {
      if (v == null || v === '') return undefined
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      return <span className={n < 0 ? 'text-danger' : undefined}>{n}</span>
    },
  },
  warehouseId: { mobileRole: 'summary' },
  voucherId: { mobileRole: 'summary' },
  remarks: { label: '摘要', width: 240 },
}

function StockEntriesPage() {
  const [viewRow, setViewRow] = useState<Row | null>(null)

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">库存分录流水</h1>
      <p className="mt-2 text-sm text-ink-500">
        库存分录明细,来源单据审核后自动生成,只读不可编辑;数量入正出负,来源单据可点开速览(头+行)。
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
        // voucherNo 与来源单据链接列文本重复;voucherType 原始类型码,链接已表意
        exclude={['voucherNo', 'voucherType', 'insertedAt']}
      />
    </>
  )
}
