import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Checkbox, Modal, Spinner, Table } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { localRowId } from '~/components/synie-editable-table/editable'
import type { Row } from '~/components/synie-data-grid/types'
import { apiData, api } from '~/lib/api/client'
import { salesOrderItemClient } from '~/lib/resources/orders'

/**
 * 「从销售订单选择」多选对话框(US 2/6):条目池 = 同公司、订单已审核未关闭、
 * 剩余可占用 > 0,可跨销售订单勾选;每行展示 订购 base / 已占用 / 剩余可占用,
 * 纳入时带出物料与单位,建议数量默认 = 剩余可占用(折回条目单位,行上可改小)。
 * 占用口径:仅已确认需求单占量(草稿不占;ADR 2026-07-25)。
 *
 * 权限行为(fail-closed):候选条目列表走 salOrderItems(需 sales.order:read),
 * 无销售读权限的计划员会看到取数失败态,不绕过;占用查询 mfgSalesItemOccupancies
 * 复用 mfg.demand:read,本身不需要销售权限。
 */

interface Occupancy {
  salesOrderItemId: string
  orderedBaseQty: string
  occupiedBaseQty: string
  remainingBaseQty: string
}

function parseOccupancies(raw: unknown): Map<string, Occupancy> {
  const list = Array.isArray(raw) ? raw : []
  const map = new Map<string, Occupancy>()
  for (const r of list) {
    const o = (typeof r === 'string' ? JSON.parse(r) : r) as Occupancy
    map.set(o.salesOrderItemId, o)
  }
  return map
}

// 数量是 6 位小数定点:去尾零展示,避免科学计数法与长串零(同库存余额表)
function formatQty(v: string): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return n.toFixed(6).replace(/\.?0+$/, '')
}

/** 剩余可占用(base) 折回条目单位数量,6 位小数截断尾零 */
function suggestQty(item: Row, remainingBaseQty: string): number {
  const base = Number(item.baseQty)
  const qty = Number(item.qty)
  const remaining = Number(remainingBaseQty)
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(qty))
    return remaining
  return Number(((remaining * qty) / base).toFixed(6))
}

export function SalesItemPicker(props: {
  /** 需求单头公司;create 态未选公司时按钮禁用 */
  companyId: string | null
  /** 已在单上的来源销售条目 id(不重复入池;拆批改走手动新增行) */
  excludeItemIds: string[]
  /** 勾选确认:把新行(带 local: 前缀 id)并给父级 items */
  onConfirm: (rows: Row[]) => void
  /** 新行起始行号 */
  nextIdx: number
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const candidates = useQuery({
    queryKey: ['salesItemPool', props.companyId],
    enabled: open && !!props.companyId,
    queryFn: () =>
      salesOrderItemClient
        .query({
          limit: 200,
          offset: 0,
          sort: { column: 'orderDate', direction: 'descending' },
          filter: {
            companyId: {
              kind: 'fk',
              op: 'in',
              values: [props.companyId!],
              labels: [],
            },
            orderStatus: { kind: 'enum', values: ['AUDITED'] },
          },
        })
        .then((result) => result.results),
  })

  const ids = useMemo(
    () => (candidates.data ?? []).map((r) => r.id),
    [candidates.data],
  )
  const occupancies = useQuery({
    queryKey: ['mfgSalesItemOccupancies', ids],
    enabled: open && ids.length > 0,
    queryFn: () =>
      apiData<{ results: unknown[] }>(
        api.manufacturing['sales-item-occupancies'].$post({
          json: { salesOrderItemIds: ids },
        }),
      ).then((result) => parseOccupancies(result.results)),
  })

  // 条目池:剩余可占用 > 0 且不在本单已纳来源里(占用只认已确认需求单,草稿不占)
  const pool = useMemo(() => {
    const occ = occupancies.data
    if (!candidates.data || !occ) return []
    const excluded = new Set(props.excludeItemIds)
    return candidates.data.filter((r) => {
      if (excluded.has(r.id)) return false
      const o = occ.get(r.id)
      return o != null && Number(o.remainingBaseQty) > 0
    })
  }, [candidates.data, occupancies.data, props.excludeItemIds])

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const confirm = () => {
    const occ = occupancies.data!
    const rows = pool
      .filter((r) => selected.has(r.id))
      .map((r, i) => {
        const o = occ.get(r.id)!
        return {
          id: localRowId(),
          idx: props.nextIdx + i,
          materialId: r.materialId,
          unitId: r.unitId,
          qty: suggestQty(r, o.remainingBaseQty),
          needDate: null,
          salesOrderItemId: r.id,
          remarks: null,
          // 带上 join 对象,表格 fk 单元格零反查直接显示标签
          material: {
            id: r.materialId,
            code: r.materialCode,
            name: r.materialName,
          },
          unit: { id: r.unitId, name: r.unitName },
        } as Row
      })
    props.onConfirm(rows)
    setOpen(false)
  }

  const loading =
    candidates.isPending || (ids.length > 0 && occupancies.isPending)
  const loadError = candidates.error ?? occupancies.error

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        isDisabled={!props.companyId}
        onPress={() => {
          setSelected(new Set())
          setOpen(true)
        }}
      >
        从销售订单选择
      </Button>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container>
          <Modal.Dialog className="max-w-4xl" aria-label="从销售订单选择">
            <Modal.Header>
              <Modal.Heading>从销售订单选择</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {loading ? (
                <div className="flex h-48 items-center justify-center">
                  <Spinner />
                </div>
              ) : loadError ? (
                // fail-closed:无销售读权限等场景如实展示错误,不降级绕过
                <EmptyState size="sm" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>候选条目加载失败</EmptyState.Title>
                    <EmptyState.Description>
                      {(loadError as Error).message}
                    </EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        void candidates.refetch()
                        void occupancies.refetch()
                      }}
                    >
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : pool.length === 0 ? (
                <EmptyState size="sm" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>无可纳入的销售条目</EmptyState.Title>
                    <EmptyState.Description>
                      条目池 = 同公司、订单已审核未关闭、剩余可占用大于 0
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <Table>
                  <Table.ScrollContainer className="max-h-96">
                    <Table.Content aria-label="可纳入销售条目">
                      <Table.Header>
                        <Table.Column className="w-10" />
                        <Table.Column>销售订单</Table.Column>
                        <Table.Column>物料</Table.Column>
                        <Table.Column>单位</Table.Column>
                        <Table.Column className="text-end">订购</Table.Column>
                        <Table.Column className="text-end">已占用</Table.Column>
                        <Table.Column className="text-end">
                          剩余可占用
                        </Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {pool.map((r) => {
                          const o = occupancies.data!.get(r.id)!
                          return (
                            <Table.Row key={r.id}>
                              <Table.Cell>
                                <Checkbox
                                  slot={null}
                                  aria-label={`选择 ${String(r.materialName ?? r.id)}`}
                                  isSelected={selected.has(r.id)}
                                  onChange={(on) => toggle(r.id, on)}
                                >
                                  <Checkbox.Content>
                                    <Checkbox.Control>
                                      <Checkbox.Indicator />
                                    </Checkbox.Control>
                                  </Checkbox.Content>
                                </Checkbox>
                              </Table.Cell>
                              <Table.Cell>
                                {String(
                                  (r.order as Row | null)?.orderNo ?? '—',
                                )}
                              </Table.Cell>
                              <Table.Cell>
                                <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
                                  <span className="truncate font-medium">
                                    {String(r.materialCode ?? '')}{' '}
                                    {String(r.materialName ?? '')}
                                  </span>
                                  {r.materialSpec != null &&
                                    r.materialSpec !== '' && (
                                      <span className="truncate text-xs text-muted">
                                        规格 {String(r.materialSpec)}
                                      </span>
                                    )}
                                </div>
                              </Table.Cell>
                              <Table.Cell>
                                {String(r.unitName ?? '—')}
                              </Table.Cell>
                              <Table.Cell className="text-end">
                                {formatQty(o.orderedBaseQty)}
                              </Table.Cell>
                              <Table.Cell className="text-end">
                                {formatQty(o.occupiedBaseQty)}
                              </Table.Cell>
                              <Table.Cell className="text-end">
                                {formatQty(o.remainingBaseQty)}
                              </Table.Cell>
                            </Table.Row>
                          )
                        })}
                      </Table.Body>
                    </Table.Content>
                  </Table.ScrollContainer>
                </Table>
              )}
            </Modal.Body>
            <Modal.Footer>
              <span className="mr-auto text-sm text-muted">
                已选 {selected.size} 条
              </span>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button isDisabled={selected.size === 0} onPress={confirm}>
                纳入需求单
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
