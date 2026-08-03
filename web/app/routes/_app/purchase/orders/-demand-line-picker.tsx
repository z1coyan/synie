import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Checkbox, Modal, Spinner, Table } from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import { localRowId } from '~/components/synie-editable-table/editable'
import type { Row } from '~/components/synie-data-grid/types'
import { queryPurchaseOrderDemandLines } from '~/lib/resources/orders'

/**
 * 「从需求单勾选」多选对话框:池 = 已确认未关闭未作废 + 未完成 + 剩余可安排>0 +
 * 公司一致（不再按行级履约方式过滤；普通采购/委外审核时分别倒写对应安排）。
 * 带入落物料/数量(默认剩余可安排)/需求日/来源需求行;报价/单价走现有机制。
 * 权限挂 purchase.order:read,采购员不必持需求单读权限。
 */

interface PoolLine {
  id: string
  demandId: string
  demandNo: string
  idx: number
  companyId: string
  materialId: string
  unitId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  baseQty: string
  orderedQty: string
  remainingBaseQty: string
  suggestedQty: string
  needDate: string | null
}

function formatQty(v: string): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return n.toFixed(6).replace(/\.?0+$/, '')
}

export function DemandLinePicker(props: {
  companyId: string | null
  isOutsourced: boolean
  nextIdx: number
  onConfirm: (rows: Row[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const poolQuery = useQuery({
    queryKey: ['purchaseOrderDemandLinePool', props.companyId, props.isOutsourced],
    enabled: open && !!props.companyId,
    queryFn: () =>
      queryPurchaseOrderDemandLines({
        companyId: props.companyId!,
        isOutsourced: props.isOutsourced,
      }).then((lines) => lines as unknown as PoolLine[]),
  })

  const pool = useMemo(() => poolQuery.data ?? [], [poolQuery.data])

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const confirm = () => {
    const rows = pool
      .filter((r) => selected.has(r.id))
      .map((r, i) => {
        return {
          id: localRowId(),
          idx: props.nextIdx + i,
          materialId: r.materialId,
          unitId: r.unitId,
          qty: Number(r.suggestedQty),
          price: 0,
          taxRate: 0.13,
          remarks: null,
          quotationItemId: null,
          bomId: null,
          demandLineId: r.id,
          demandDate: r.needDate,
          material: { id: r.materialId, code: r.materialCode, name: r.materialName },
          unit: { id: r.unitId, name: r.unitName },
        } as Row
      })
    props.onConfirm(rows)
    setOpen(false)
  }

  const loading = poolQuery.isPending
  const loadError = poolQuery.error

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
        从需求单勾选
      </Button>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container>
          <Modal.Dialog className="max-w-4xl" aria-label="从需求单勾选">
            <Modal.Header>
              <Modal.Heading>
                从需求单勾选（{props.isOutsourced ? '委外' : '外购'}）
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              {loading ? (
                <div className="flex h-48 items-center justify-center">
                  <Spinner />
                </div>
              ) : loadError ? (
                <EmptyState size="sm" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>需求行池加载失败</EmptyState.Title>
                    <EmptyState.Description>{(loadError as Error).message}</EmptyState.Description>
                  </EmptyState.Header>
                  <EmptyState.Content>
                    <Button size="sm" variant="secondary" onPress={() => void poolQuery.refetch()}>
                      重试
                    </Button>
                  </EmptyState.Content>
                </EmptyState>
              ) : pool.length === 0 ? (
                <EmptyState size="sm" className="h-48 justify-center">
                  <EmptyState.Header>
                    <EmptyState.Title>暂无可下单需求行</EmptyState.Title>
                    <EmptyState.Description>
                      仅列出已确认未完成、剩余可安排 &gt; 0 的本公司需求行（可与生产等混排）。
                    </EmptyState.Description>
                  </EmptyState.Header>
                </EmptyState>
              ) : (
                <Table aria-label="需求行池">
                  <Table.ScrollContainer>
                    <Table.Content>
                      <Table.Header>
                        <Table.Column isRowHeader>选</Table.Column>
                        <Table.Column>需求单号</Table.Column>
                        <Table.Column>物料</Table.Column>
                        <Table.Column>需求数量(默认单位)</Table.Column>
                        <Table.Column>已安排</Table.Column>
                        <Table.Column>剩余可安排</Table.Column>
                        <Table.Column>需求日</Table.Column>
                      </Table.Header>
                      <Table.Body>
                        {pool.map((r) => (
                          <Table.Row key={r.id}>
                            <Table.Cell>
                              <Checkbox
                                isSelected={selected.has(r.id)}
                                onChange={(v) => toggle(r.id, v)}
                              >
                                <span className="sr-only">选择</span>
                              </Checkbox>
                            </Table.Cell>
                            <Table.Cell>{r.demandNo}</Table.Cell>
                            <Table.Cell>
                              <div className="flex flex-col">
                                <span>
                                  {r.materialCode} {r.materialName}
                                </span>
                                {r.materialSpec ? (
                                  <span className="text-xs text-muted">{r.materialSpec}</span>
                                ) : null}
                              </div>
                            </Table.Cell>
                            {/* 投影列与剩余可下单同默认单位口径,避免与行单位混显 */}
                            <Table.Cell>{formatQty(r.baseQty)}</Table.Cell>
                            <Table.Cell>{formatQty(r.orderedQty)}</Table.Cell>
                            <Table.Cell>{formatQty(r.remainingBaseQty)}</Table.Cell>
                            <Table.Cell>{r.needDate ?? '—'}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Content>
                  </Table.ScrollContainer>
                </Table>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                取消
              </Button>
              <Button isDisabled={selected.size === 0} onPress={confirm}>
                带入 {selected.size > 0 ? `(${selected.size})` : ''}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )
}
