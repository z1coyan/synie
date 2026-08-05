import { useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Chip, Link } from '@heroui/react'
import { formatPrice } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { AUDIT_DOC_STATUS_ENUM_COLORS, docActionVisible } from '~/lib/doc-status'
import { materialCellRender } from '~/components/synie-material-cell/MaterialCell'
import { useAuditDoc } from '../../scm/-audit-doc'
import { salesQuotationAuditConfig, useQuotationDrawer, type OpenQuotationDrawer } from './-quotation-drawer'
import { isExpired } from './quotations'

export const Route = createFileRoute('/_app/sales/quotations/items')({
  component: QuotationItemsTab,
})

// 行级明细列白名单:头信息(quotationDate/validUntil/partyId/quotationStatus/currencyCode 由
// 后端 gridMeta 以 calc/多态 fk 列下发)+ 行自身字段;行号/税率不进网格(税率进抽屉看),
// companyId 作单据归属公司首列;insertedAt/updatedAt 不进表格(兼当 exclude)。
// 物料/单位走快照文本列(报价时落库,防主数据改名影响历史单显示);
// 物料按全站约定合并为单个富单元格列(materialCode 列承载,其余快照字段经 extraFields 取回);
// 梯度行单价空、档数列提示进抽屉看阶梯
const GRID_COLUMNS = [
  'companyId',
  'quotationId',
  'quotationDate',
  'validUntil',
  'partyId',
  'quotationStatus',
  'materialCode',
  'unitName',
  'currencyCode',
  'pricingMode',
  'price',
  'tierCount',
  'remarks',
]

// 行编辑/审核整单仅草稿单放行(后端 SyncQuotation 权威校验兜底,这里做体验层);删除不进条目视图
const ACTION_VISIBLE = docActionVisible({ edit: ['DRAFT'], auditDoc: ['DRAFT'] }, 'quotationStatus')

// quotationId 列覆盖默认 FkLink(速览抽屉):点击开共享完整报价抽屉,与点行的「查看」一致。
// fk label 读取资源返回的 quotation 关系标签，拿不到时退回截断 id。
function buildOverrides(openDrawer: OpenQuotationDrawer) {
  return {
    // 卡片:物料作标题、客户作副标题、状态/单价/截止日期作摘要
    companyId: { mobileRole: 'hide' },
    // 物料列:全站统一富单元格(快照四字段,编号点开物料速览);报价条目无图纸挂接,
    // 缩略图回退物料当前图纸
    materialCode: {
      label: '物料',
      mobileRole: 'title',
      filterField: 'materialId',
      render: materialCellRender(),
    },
    partyId: { mobileRole: 'subtitle' },
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
    validUntil: { label: '报价截止', mobileRole: 'summary' },
    // 与报价单 tab 同一套状态胶囊配色:草稿灰、已审核绿、已作废红;过期黄(派生态)
    quotationStatus: {
      label: '状态',
      mobileRole: 'summary',
      enumColors: AUDIT_DOC_STATUS_ENUM_COLORS,
      render: (v: unknown, row: Row) =>
        isExpired(v, row.validUntil) ? (
          <Chip size="sm" className="whitespace-nowrap" color="warning">
            已过期
          </Chip>
        ) : undefined,
    },
    pricingMode: { label: '定价模式' },
    price: {
      label: '含税单价',
      mobileRole: 'summary',
      render: (v: unknown) => (v == null ? undefined : formatPrice(v)),
    },
    // 档数只对梯度行有意义,固定价行留白
    tierCount: {
      label: '档数',
      render: (v: unknown, row: Row) => (row.pricingMode === 'QTY_TIERED' ? String(v ?? 0) : ''),
    },
  } satisfies Record<string, ColumnOverride>
}

function QuotationItemsTab() {
  const openDrawer = useQuotationDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(salesQuotationAuditConfig)
  // openDrawer 是 context 稳定引用,overrides 不会因网格重渲染反复重建列定义
  const overrides = useMemo(() => buildOverrides(openDrawer), [openDrawer])

  return (
    <>
      <SynieDataGrid
        resource="salQuotationItems"
        columns={GRID_COLUMNS}
        overrides={overrides}
        // 物料富单元格所需快照字段与物料外键的取数
        extraFields={['materialId', 'materialName', 'materialSpec', 'customerPartNo']}
        // 默认报价日期倒序(新单在前);calc 列排序沿用销售订单条目已验证的能力
        defaultSort={{ column: 'quotationDate', direction: 'descending' }}
        createLabel="新建报价单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => openDrawer('view', { id: String(row.quotationId), status: row.quotationStatus })}
        onEdit={(row) => openDrawer('edit', { id: String(row.quotationId), status: row.quotationStatus })}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.quotationId == null || row.quotationId === '') return
              requestAudit(String(row.quotationId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
