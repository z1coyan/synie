import { useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Link } from '@heroui/react'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useOrderDrawer, type OpenOrderDrawer } from './-order-drawer'

export const Route = createFileRoute('/_app/scm/sales-orders/items')({
  component: SalesOrderItemsTab,
})

// 行级明细列白名单:头信息(orderDate/partyId/orderStatus 由后端 gridMeta 以 calc/多态 fk 列下发,
// 判别列 partyType 不出列也随查询取回,对手列照常解析)
// + 行自身字段;行号/税率/含税金额与客户料号不进网格(行号对跨单浏览无意义,税率/金额进抽屉看),
// companyId/insertedAt/updatedAt 不进表格(兼当 exclude)。
// 物料/单位走快照文本列(下单时落库,防主数据改名/换码影响历史单显示)
const GRID_COLUMNS = [
  'orderId',
  'orderDate',
  'partyId',
  'orderStatus',
  'materialCode',
  'materialName',
  'materialSpec',
  'unitName',
  'qty',
  'price',
  'remarks',
]

// 行编辑仅草稿单放行(后端 SyncOrder 权威校验兜底,这里做体验层);审核/关闭/作废/删除不进条目视图
const ACTION_VISIBLE = {
  edit: (row: Row) => row.orderStatus === 'DRAFT',
} satisfies Record<string, (row: Row) => boolean>

// orderId 列覆盖默认 FkLink(速览抽屉):点击开共享完整订单抽屉,与点行的「查看」一致。
// fk label 走行查询 join(buildRowQuery:order { id orderNo }),拿不到退截断 id
function buildOverrides(openDrawer: OpenOrderDrawer) {
  return {
    orderId: {
      render: (_v: unknown, row: Row) => {
        const order = row.order as Row | null | undefined
        const orderNo = order?.orderNo
        return (
          <Link
            onPress={() => openDrawer('view', { id: String(row.orderId), status: row.orderStatus })}
            className="inline-block max-w-80 cursor-pointer truncate align-bottom text-inherit underline-offset-2 hover:underline"
          >
            {orderNo != null ? String(orderNo) : String(row.orderId).slice(0, 8)}
          </Link>
        )
      },
    },
    // 与订单 tab 同一套状态胶囊配色:草稿灰、已审核绿、已关闭黄、已作废红
    orderStatus: {
      label: '状态',
      enumColors: { DRAFT: 'default', AUDITED: 'success', CLOSED: 'warning', VOIDED: 'danger' },
    },
  } satisfies Record<string, ColumnOverride>
}

function SalesOrderItemsTab() {
  const openDrawer = useOrderDrawer()
  // openDrawer 是 context 稳定引用,overrides 不会因网格重渲染反复重建列定义
  const overrides = useMemo(() => buildOverrides(openDrawer), [openDrawer])

  return (
    <SynieDataGrid
      resource="salOrderItems"
      columns={GRID_COLUMNS}
      overrides={overrides}
      // 行图纸:sys_attachment 挂接(owner_type sal_order_item / category drawing),与物料页同机制的虚拟列
      attachmentImages={{ ownerType: 'sal_order_item', category: 'drawing', label: '图纸' }}
      // 默认订单日期倒序(新单在前);calc 列排序后端已验证支持
      defaultSort={{ column: 'orderDate', direction: 'descending' }}
      // salOrderItems 复用 sales.order 权限码,meta capabilities 为空:显式声明本视图可用动作
      // (整单「新建订单」+ 草稿单「编辑」),不声明 delete,删除不进条目视图
      capabilities={['create', 'update']}
      createLabel="新建订单"
      onCreate={() => openDrawer('create', null)}
      onView={(row) => openDrawer('view', { id: String(row.orderId), status: row.orderStatus })}
      onEdit={(row) => openDrawer('edit', { id: String(row.orderId), status: row.orderStatus })}
      actionVisible={ACTION_VISIBLE}
    />
  )
}
