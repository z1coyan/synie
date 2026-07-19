import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '@heroui-pro/react'
import { gqlFetch } from '~/lib/graphql'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { SynieRecordDrawer } from '~/components/synie-record-drawer/SynieRecordDrawer'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'

export const Route = createFileRoute('/_app/scm/stock-entries')({
  component: StockEntriesPage,
})

/**
 * 库存分录流水(ADR 2026-07-19-stock-ledger):库存领域唯一事实表,只追加不可改,
 * 由来源单据(手工出入库单/手工调拨单)审核时派生;作废不删行,仅标记 isCancelled。
 * 数量带符号(入正出负,物料默认单位口径)。页面只读:常规列筛选 + 来源单据多态链接列。
 */

// 列白名单:公司由页面顶部选定不进列;seq/时间戳不进表格
const GRID_COLUMNS = [
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
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [companyRow, setCompanyRow] = useState<Row | null>(null)
  const [viewRow, setViewRow] = useState<Row | null>(null)

  // 公司列表:仅一家时自动选中(照仓库管理页先例)
  const companies = useQuery({
    queryKey: ['stockEntryCompanies'],
    queryFn: () =>
      gqlFetch<{ basCompanies: { count: number; results: Row[] } }>(
        `query { basCompanies(limit: 50, offset: 0, sort: [{field: CODE, order: ASC}]) { count results { id name } } }`
      ).then((d) => d.basCompanies),
  })

  useEffect(() => {
    if (companyId == null && companies.data?.count === 1) {
      const only = companies.data.results[0]
      setCompanyId(only.id)
      setCompanyRow(only)
    }
  }, [companies.data, companyId])

  return (
    <>
      <h1 className="font-brand text-3xl tracking-wide">库存分录流水</h1>
      <p className="mt-2 text-sm text-ink-500">
        库存分录明细,来源单据审核后自动生成,只读不可编辑;数量入正出负,来源单据可点开速览。
      </p>

      <div className="mt-6 max-w-xs">
        <RemoteSelect
          resource="basCompanies"
          label="公司"
          placeholder="选择公司…"
          value={companyId}
          initialRows={companyRow ? [companyRow] : (companies.data?.results ?? [])}
          onChange={(id, row) => {
            setCompanyId(id)
            setCompanyRow(row)
          }}
        />
      </div>

      <div className="mt-6">
        {companyId == null ? (
          <EmptyState size="md" className="h-64 justify-center">
            <EmptyState.Header>
              <EmptyState.Title>请先选择公司</EmptyState.Title>
              <EmptyState.Description>库存分录按公司过滤,选择公司后查看流水。</EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          // 分录只读:不传 onCreate/onEdit 即无新增/编辑入口;来源单据是多态 fk 链接列(GridMeta poly_refs 反射)
          <SynieDataGrid
            key={companyId}
            resource="invStockEntries"
            columns={GRID_COLUMNS}
            overrides={GRID_OVERRIDES}
            fixedFilter={{ companyId: { eq: companyId } }}
            defaultSort={{ column: 'postingDate', direction: 'descending' }}
            onView={setViewRow}
          />
        )}
      </div>

      <SynieRecordDrawer
        resource="invStockEntries"
        label="库存分录"
        mode="view"
        isOpen={viewRow !== null}
        onOpenChange={(open) => !open && setViewRow(null)}
        row={viewRow}
        // voucherType 原始类型码,来源单据链接已表意;公司页面顶部已选定
        exclude={['companyId', 'voucherType', 'insertedAt']}
      />
    </>
  )
}
