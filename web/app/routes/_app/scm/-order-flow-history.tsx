import { useQuery } from '@tanstack/react-query'
import { Chip, Spinner, Table } from '@heroui/react'
import { formatQty } from '~/lib/amount'
import { getPurchaseOrderHistory, getSalesOrderHistory } from '~/lib/resources/orders'
import { resourceBindingFor } from '~/lib/resources/registry'

const FLOW_LABELS: Record<string, string> = {
  'purchase.receipt': '采购入库',
  'sales.delivery': '销售发货',
}

/** 订单「收发货历史」只读表；历史由订单专用 REST 端点聚合，不再查询 GraphQL 视图。 */
export function OrderFlowHistory({
  orderId,
  side,
}: {
  orderId: string
  side: 'sales' | 'purchase'
}) {
  const orderFlowCache = resourceBindingFor('scmOrderFlowItems').cache
  const history = useQuery({
    queryKey: orderFlowCache.gridKey('orderHistory', side, orderId),
    queryFn: () =>
      (side === 'sales'
        ? getSalesOrderHistory(orderId)
        : getPurchaseOrderHistory(orderId)),
  })

  if (history.isPending) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (history.error) {
    return <div className="p-4 text-sm text-danger">收发货历史加载失败：{history.error.message}</div>
  }
  if (!history.data?.length) {
    return <div className="p-8 text-center text-sm text-muted">暂无收发货记录</div>
  }

  return (
    <Table aria-label="收发货历史">
      <Table.ScrollContainer>
        <Table.Content>
          <Table.Header>
            <Table.Column isRowHeader>单据类型</Table.Column>
            <Table.Column>单据编号</Table.Column>
            <Table.Column>单据日期</Table.Column>
            <Table.Column>状态</Table.Column>
            <Table.Column>物料</Table.Column>
            <Table.Column>单位</Table.Column>
            <Table.Column>数量</Table.Column>
          </Table.Header>
          <Table.Body>
            {history.data.map((row, index) => {
              const material = [row.materialCode, row.materialName].filter(Boolean).join(' ')
              return (
                <Table.Row
                  key={`${row.flowType}:${row.documentNo}:${row.documentDate}:${index}`}
                >
                  <Table.Cell>{FLOW_LABELS[row.flowType] ?? row.flowType}</Table.Cell>
                  <Table.Cell>{row.documentNo}</Table.Cell>
                  <Table.Cell>{row.documentDate}</Table.Cell>
                  <Table.Cell>
                    <Chip
                      size="sm"
                      color={
                        row.status === 'AUDITED'
                          ? 'success'
                          : row.status === 'VOIDED'
                            ? 'danger'
                            : 'default'
                      }
                    >
                      {row.status}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
                      <span className="truncate font-medium">{material || '—'}</span>
                      {row.materialSpec ? (
                        <span className="truncate text-xs text-muted">规格 {row.materialSpec}</span>
                      ) : null}
                      {row.customerPartNo ? (
                        <span className="truncate text-xs text-muted">
                          客户料号 {row.customerPartNo}
                        </span>
                      ) : null}
                    </div>
                  </Table.Cell>
                  <Table.Cell>{row.unitName ?? '—'}</Table.Cell>
                  <Table.Cell>{formatQty(row.quantity) || '—'}</Table.Cell>
                </Table.Row>
              )
            })}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  )
}
