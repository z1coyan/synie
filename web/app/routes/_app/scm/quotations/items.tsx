import { useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Chip, Link } from '@heroui/react'
import { formatPrice } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useQuotationDrawer, type OpenQuotationDrawer } from './-quotation-drawer'
import { isExpired } from './quotations'

export const Route = createFileRoute('/_app/scm/quotations/items')({
  component: QuotationItemsTab,
})

// 行级明细列白名单:头信息(quotationDate/validUntil/partyId/quotationStatus/currencyCode 由
// 后端 gridMeta 以 calc/多态 fk 列下发)+ 行自身字段;行号/税率不进网格(税率进抽屉看),
// companyId/insertedAt/updatedAt 不进表格(兼当 exclude)。
// 物料/单位走快照文本列(报价时落库,防主数据改名影响历史单显示);
// 梯度行单价空、档数列提示进抽屉看阶梯
const GRID_COLUMNS = [
  'quotationId',
  'quotationDate',
  'validUntil',
  'partyId',
  'quotationStatus',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  'currencyCode',
  'pricingMode',
  'price',
  'tierCount',
  'remarks',
]

// 行编辑仅草稿单放行(后端 SyncQuotation 权威校验兜底,这里做体验层)
const ACTION_VISIBLE = {
  edit: (row: Row) => row.quotationStatus === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// quotationId 列覆盖默认 FkLink(速览抽屉):点击开共享完整报价抽屉,与点行的「查看」一致。
// fk label 走行查询 join(buildRowQuery:quotation { id quotationNo }),拿不到退截断 id
function buildOverrides(openDrawer: OpenQuotationDrawer) {
  return {
    quotationId: {
      render: (_v: unknown, row: Row) => {
        const quotation = row.quotation as Row | null | undefined
        const quotationNo = quotation?.quotationNo
        return (
          <Link
            onPress={() => openDrawer('view', { id: String(row.quotationId), status: row.quotationStatus })}
            className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
          >
            {quotationNo != null ? String(quotationNo) : String(row.quotationId).slice(0, 8)}
          </Link>
        )
      },
    },
    validUntil: { label: '报价截止' },
    // 与报价单 tab 同一套状态胶囊配色:草稿灰、已审核绿、已作废红;过期黄(派生态)
    quotationStatus: {
      label: '状态',
      enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' },
      render: (v: unknown, row: Row) =>
        isExpired(v, row.validUntil) ? (
          <Chip size="sm" className="whitespace-nowrap" color="warning">
            已过期
          </Chip>
        ) : undefined,
    },
    pricingMode: { label: '定价模式' },
    price: { label: '含税单价', render: (v: unknown) => (v == null ? undefined : formatPrice(v)) },
    // 档数只对梯度行有意义,固定价行留白
    tierCount: {
      label: '档数',
      render: (v: unknown, row: Row) => (row.pricingMode === 'QTY_TIERED' ? String(v ?? 0) : ''),
    },
  } satisfies Record<string, ColumnOverride>
}

function QuotationItemsTab() {
  const openDrawer = useQuotationDrawer()
  // openDrawer 是 context 稳定引用,overrides 不会因网格重渲染反复重建列定义
  const overrides = useMemo(() => buildOverrides(openDrawer), [openDrawer])

  return (
    <SynieDataGrid
      resource="salQuotationItems"
      columns={GRID_COLUMNS}
      overrides={overrides}
      // 默认报价日期倒序(新单在前);calc 列排序沿用销售订单条目已验证的能力
      defaultSort={{ column: 'quotationDate', direction: 'descending' }}
      // salQuotationItems 复用 sales.quotation 权限码,meta capabilities 为空:显式声明本视图
      // 可用动作(整单「新建报价单」+ 草稿单「编辑」),不声明 delete,删除不进条目视图
      capabilities={['create', 'update']}
      createLabel="新建报价单"
      onCreate={() => openDrawer('create', null)}
      onView={(row) => openDrawer('view', { id: String(row.quotationId), status: row.quotationStatus })}
      onEdit={(row) => openDrawer('edit', { id: String(row.quotationId), status: row.quotationStatus })}
      actionVisible={ACTION_VISIBLE}
    />
  )
}
