import { useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Chip, Link } from '@heroui/react'
import { formatAmount, formatPrice } from '~/lib/amount'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useAuditDoc } from '../-audit-doc'
import { purchaseOrderAuditConfig, useOrderDrawer, type OpenOrderDrawer } from './-order-drawer'
import { QtyProgressCell } from '../-qty-progress-cell'
import { purchaseOrderItemClient } from '~/lib/resources/orders'

export const Route = createFileRoute('/_app/scm/purchase/items')({
  component: PurchaseOrderItemsTab,
})

// 行级明细列白名单:头信息(orderDate/partyId/orderStatus/currencyCode 由后端 gridMeta 以
// calc/多态 fk 列下发,判别列 partyType 不出列也随查询取回,对手列照常解析)
// + 行自身字段;行号/税率与客户料号不进网格(行号对跨单浏览无意义,税率进抽屉看),
// companyId 作单据归属公司首列;insertedAt/updatedAt 不进表格(兼当 exclude)。
// 物料/单位走快照文本列(下单时落库,防主数据改名/换码影响历史单显示)。
// 跨订单混合行,双币金额恒全列展示(本币单两套同值;简化只在订单抽屉内,ADR 双币)
const GRID_COLUMNS = [
  'companyId',
  'orderId',
  'orderDate',
  'partyId',
  'orderStatus',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  // 数量/已收/未收并一列:列本体是未收数量计算列(筛选/排序即未收口径),
  // 单元格进度条渲染,行数量与已收由 extraFields 补取
  'remainingBaseQty',
  'currencyCode',
  'basePrice',
  'price',
  'baseAmount',
  'amount',
  'remarks',
]

// 行编辑/审核整单仅草稿单放行(后端 SyncOrder 权威校验兜底,这里做体验层);关闭/作废/删除不进条目视图
const ACTION_VISIBLE = {
  edit: (row: Row) => row.orderStatus === 'DRAFT',
  auditDoc: (row: Row) => row.orderStatus === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// orderId 列覆盖默认 FkLink(速览抽屉):点击开共享完整订单抽屉,与点行的「查看」一致。
// fk label 读取资源返回的 order 关系标签，拿不到时退回截断 id。
// 委外订单的条目在订单号旁跟一枚 accent「委外」胶囊(普通采购不显示,少数派标记);
// 委外标记是订单头属性,由 orderIsOutsourced 计算列经 extraFields 随查询取回
function buildOverrides(openDrawer: OpenOrderDrawer) {
  return {
    // 卡片:物料作标题、供应商作副标题、状态/进度/金额作摘要;公司首列桌面保留筛选,卡片藏
    companyId: { mobileRole: 'hide' },
    materialCode: { mobileRole: 'hide' },
    materialSpec: { mobileRole: 'hide' },
    materialName: {
      mobileRole: 'title',
      render: (_v: unknown, row: Row) => {
        const code = row.materialCode != null ? String(row.materialCode) : ''
        const name = row.materialName != null ? String(row.materialName) : ''
        const text = [code, name].filter(Boolean).join(' ')
        return text || undefined
      },
    },
    partyId: { mobileRole: 'subtitle' },
    orderId: {
      render: (_v: unknown, row: Row) => {
        const order = row.order as Row | null | undefined
        const orderNo = order?.orderNo
        return (
          <span className="inline-flex max-w-80 items-center gap-1 align-bottom">
            <Link
              onPress={() => openDrawer('view', { id: String(row.orderId), status: row.orderStatus })}
              className="cursor-pointer truncate text-inherit underline-offset-2 hover:underline"
            >
              {orderNo != null ? String(orderNo) : String(row.orderId).slice(0, 8)}
            </Link>
            {row.orderIsOutsourced === true ? (
              <Chip size="sm" color="accent" className="shrink-0">
                委外
              </Chip>
            ) : null}
          </span>
        )
      },
    },
    // 与订单 tab 同一套状态胶囊配色:草稿灰、已审核绿、已关闭黄、已作废红
    orderStatus: {
      label: '状态',
      mobileRole: 'summary',
      enumColors: { DRAFT: 'default', AUDITED: 'success', CLOSED: 'warning', VOIDED: 'danger' },
    },
    // 合并列:进度条展示 已收/数量·未收(折回行单位,见 QtyProgressCell);列筛选/排序=未收数量
    remainingBaseQty: {
      label: '收货进度',
      mobileRole: 'summary',
      align: 'start',
      render: (_v: unknown, row: Row) => (
        <QtyProgressCell row={row} doneField="receivedQty" labels={{ done: '已收', remaining: '未收' }} />
      ),
    },
    // 双币金额列(定案顺序:本币单价、原币单价、本币金额、原币金额);本币单价 4 位精度
    basePrice: { label: '本币单价', render: (v: unknown) => formatPrice(v) },
    price: { label: '原币单价', render: (v: unknown) => formatPrice(v) },
    baseAmount: { label: '本币金额', mobileRole: 'summary', render: (v: unknown) => formatAmount(v) },
    amount: { label: '原币金额', render: (v: unknown) => formatAmount(v) },
  } satisfies Record<string, ColumnOverride>
}

function PurchaseOrderItemsTab() {
  const openDrawer = useOrderDrawer()
  const { requestAudit, auditDialog } = useAuditDoc(purchaseOrderAuditConfig)
  // openDrawer 是 context 稳定引用,overrides 不会因网格重渲染反复重建列定义
  const overrides = useMemo(() => buildOverrides(openDrawer), [openDrawer])

  return (
    <>
      <SynieDataGrid
        resource="purOrderItems"
        client={purchaseOrderItemClient}
        columns={GRID_COLUMNS}
        overrides={overrides}
        // 合并进度列的取数(qty 行单位;baseQty/receivedQty 默认单位投影列);
        // orderIsOutsourced 供订单号旁的「委外」胶囊(订单头计算列,不出独立列)
        extraFields={['qty', 'baseQty', 'receivedQty', 'orderIsOutsourced']}
        // 行图纸:sys_attachment 挂接(owner_type pur_order_item / category drawing),与销售订单条目同机制
        attachmentImages={{ ownerType: 'pur_order_item', category: 'drawing', label: '图纸' }}
        // 默认订单日期倒序(新单在前);calc 列排序后端已验证支持
        defaultSort={{ column: 'orderDate', direction: 'descending' }}
        // purOrderItems 复用 purchase.order 权限码,meta capabilities 为空:显式声明本视图可用动作
        // (整单「新建订单」+ 草稿单「编辑/审核整单」),不声明 delete,删除不进条目视图
        capabilities={['create', 'update', 'audit']}
        createLabel="新建订单"
        onCreate={() => openDrawer('create', null)}
        onView={(row) => openDrawer('view', { id: String(row.orderId), status: row.orderStatus })}
        onEdit={(row) => openDrawer('edit', { id: String(row.orderId), status: row.orderStatus })}
        rowActions={[
          {
            key: 'auditDoc',
            label: '审核整单',
            capability: 'audit',
            onAction: (row, ctx) => {
              if (row.orderId == null || row.orderId === '') return
              requestAudit(String(row.orderId), ctx.refetch)
            },
          },
        ]}
        actionVisible={ACTION_VISIBLE}
      />
      {auditDialog}
    </>
  )
}
