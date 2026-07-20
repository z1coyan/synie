import { createFileRoute } from '@tanstack/react-router'
import { SynieDataGrid, type ColumnOverride } from '~/components/synie-data-grid/SynieDataGrid'
import type { Row } from '~/components/synie-data-grid/types'
import { useDeliveryDrawer } from './-delivery-drawer'

export const Route = createFileRoute('/_app/scm/sales-deliveries/items')({
  component: DeliveryItemsTab,
})

const GRID_OVERRIDES = {
  partyType: { label: '对手类型' },
  deliveryStatus: {
    label: '发货状态',
    enumColors: { DRAFT: 'default', AUDITED: 'success', VOIDED: 'danger' },
  },
  orderNo: { label: '订单号' },
  // 物料用快照列多行展示,不 join inv.material(避免无物料读权限时整表失败)
  materialName: {
    label: '物料',
    render: (_v: unknown, r: Row) => {
      const code = r.materialCode != null ? String(r.materialCode) : ''
      const name = r.materialName != null ? String(r.materialName) : ''
      const title = [code, name].filter(Boolean).join(' ')
      if (!title && r.materialSpec == null && r.customerPartNo == null) return undefined
      const spec = r.materialSpec != null && r.materialSpec !== '' ? String(r.materialSpec) : null
      const cpn =
        r.customerPartNo != null && r.customerPartNo !== '' ? String(r.customerPartNo) : null
      return (
        <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
          {title ? <span className="truncate font-medium">{title}</span> : null}
          {spec ? (
            <span className="truncate text-xs text-muted" title={spec}>
              规格 {spec}
            </span>
          ) : null}
          {cpn ? (
            <span className="truncate text-xs text-muted" title={cpn}>
              客户料号 {cpn}
            </span>
          ) : null}
        </div>
      )
    },
  },
  unitName: { label: '单位' },
  baseQty: { label: '折算数量' },
} satisfies Record<string, ColumnOverride>

// 列全走行上快照/计算字段,不点 materialId 等会触发嵌套授权的 fk
const GRID_COLUMNS = [
  'companyId',
  'deliveryNo',
  'deliveryDate',
  'deliveryStatus',
  'orderNo',
  'partyType',
  'partyId',
  'materialName',
  'unitName',
  'qty',
  'baseQty',
]

function DeliveryItemsTab() {
  const openDrawer = useDeliveryDrawer()

  return (
    <SynieDataGrid
      resource="salDeliveryItems"
      columns={GRID_COLUMNS}
      overrides={GRID_OVERRIDES}
      defaultSort={{ column: 'deliveryDate', direction: 'descending' }}
      // 开抽屉需要母单 id;不进展示列,经 extraFields 取回(避免 deliveryId 为 undefined 过滤报错)
      extraFields={['deliveryId']}
      createLabel="新建发货单"
      onCreate={() => openDrawer('create', null)}
      onView={(row) => {
        if (row.deliveryId == null || row.deliveryId === '') return
        openDrawer('view', {
          id: String(row.deliveryId),
          status: row.deliveryStatus,
        })
      }}
      onEdit={(row) => {
        if (row.deliveryId == null || row.deliveryId === '') return
        openDrawer(row.deliveryStatus === 'DRAFT' ? 'edit' : 'view', {
          id: String(row.deliveryId),
          status: row.deliveryStatus,
        })
      }}
    />
  )
}
