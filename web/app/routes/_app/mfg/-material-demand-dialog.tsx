import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertDialog,
  Button,
  ListBox,
  Modal,
  NumberField,
  Select,
  Spinner,
  Table,
  toast,
} from '@heroui/react'
import { EmptyState } from '@heroui-pro/react'
import type { Row } from '~/components/synie-data-grid/types'
import {
  generateMaterialDemand,
  getMaterialDemandPreview,
} from '~/lib/resources/manufacturing'
import { departmentClient } from '~/lib/resources/iam'
import { resourceBindingFor } from '~/lib/resources/registry'
import { toastError } from '~/lib/toast'

/**
 * 「生成物料需求」分流弹窗：按工单 BOM 快照展开配料，毛需求与参考库存由服务端
 * 取数（票 02：库存引擎按公司全仓聚合的现货快照，只读不锁不扣，折算行单位）；
 * 数量默认=毛需求−参考库存（下限 0）可手改、允许大于毛需求，参考库存足够的行
 * 默认去向「不需要」（仍可改）；逐行（可批量）选去向——某车间 / 采购 / 不需要；
 * 提交后按去向分组生成需求单草稿并反馈单号清单。形态复刻销售勾选纳入需求单的
 * Modal+表格先例。
 */

/** 去向选择值：'none' = 不需要（不带出），'purchase' = 采购，其余 = 车间 id */
type TargetValue = 'none' | 'purchase' | string

interface DraftLine {
  componentId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  grossQty: string
  stockQty: string
  qty: number
  target: TargetValue
}

// 数量是 6 位小数定点:去尾零展示(同销售条目选择器)
function formatQty(v: string): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return v
  return n.toFixed(6).replace(/\.?0+$/, '')
}

export function useGenerateMaterialDemand() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Row | null>(null)
  const [lines, setLines] = useState<DraftLine[]>([])
  const [batchTarget, setBatchTarget] = useState<TargetValue>('none')
  const [running, setRunning] = useState(false)
  // 重复生成二次确认（票 04）：已存在派生草稿单号清单，非 null 时弹确认框
  const [forceConfirm, setForceConfirm] = useState<string[] | null>(null)

  const workOrderId = pending?.id == null ? null : String(pending.id)
  const companyId = pending?.companyId == null ? null : String(pending.companyId)

  const preview = useQuery({
    queryKey: ['materialDemandPreview', workOrderId],
    queryFn: () => getMaterialDemandPreview(workOrderId!),
    enabled: workOrderId != null,
  })

  // 取数后初始化行草稿：默认数量=毛−参考库存（下限 0，服务端算好）、
  // 默认去向「不需要」（参考库存足够的行天然不带出；其余行也由人逐行选，系统无默认车间/采购）
  const previewData = preview.data
  useEffect(() => {
    if (!pending || !previewData) return
    setLines(
      (previewData.lines ?? []).map((c) => ({
        componentId: c.componentId,
        materialCode: c.materialCode,
        materialName: c.materialName,
        materialSpec: c.materialSpec,
        unitName: c.unitName,
        grossQty: c.grossQty,
        stockQty: c.stockQty,
        qty: Number(c.defaultQty),
        target: 'none',
      })),
    )
    // 仅在打开新工单时按取数重建行；行编辑不回填
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id, previewData])

  // 车间候选：本公司启用中部门（与后端 resolveAssignedDept 同公司未停用同一口径）
  const departments = useQuery({
    queryKey: ['materialDemandDepts', companyId],
    enabled: pending != null && companyId != null,
    queryFn: () =>
      departmentClient
        .query({
          limit: 200,
          offset: 0,
          sort: { column: 'name', direction: 'ascending' },
          filter: {
            companyId: { kind: 'fk', op: 'in', values: [companyId!], labels: [] },
            enabled: { kind: 'bool', eq: true },
          },
        })
        .then((result) => result.results),
  })

  const deptOptions = useMemo(
    () =>
      (departments.data ?? []).map((d) => ({
        id: String(d.id),
        name: String(d.name ?? ''),
      })),
    [departments.data],
  )

  const close = () => {
    setPending(null)
    setLines([])
    setBatchTarget('none')
    setForceConfirm(null)
  }

  const patchLine = (componentId: string, patch: Partial<DraftLine>) =>
    setLines((prev) =>
      prev.map((l) => (l.componentId === componentId ? { ...l, ...patch } : l)),
    )

  const applyBatch = (target: TargetValue) => {
    setBatchTarget(target)
    setLines((prev) => prev.map((l) => ({ ...l, target })))
  }

  const chosen = lines.filter((l) => l.target !== 'none')

  const submit = async (force = false) => {
    if (!pending || chosen.length === 0) return
    const invalid = chosen.find((l) => !Number.isFinite(l.qty) || l.qty <= 0)
    if (invalid) {
      toast.danger(`「${invalid.materialName}」数量必须大于 0`)
      return
    }
    setRunning(true)
    try {
      const result = await generateMaterialDemand(
        String(pending.id),
        chosen.map((l) => ({
          componentId: l.componentId,
          qty: String(l.qty),
          target:
            l.target === 'purchase'
              ? ({ kind: 'purchase' } as const)
              : ({ kind: 'dept', deptId: l.target } as const),
        })),
        force,
      )
      // 重复生成（票 04）：已有未删除派生草稿 → 不生成，弹二次确认后才带 force 重发
      if (result.warning) {
        setForceConfirm(result.warning.existingDraftDemandNos)
        return
      }
      toast.success(`已生成 ${result.demands.length} 张需求单草稿`, {
        description: result.demands.map((d) => d.demandNo).join('、'),
      })
      for (const resource of ['mfgDemands', 'mfgDemandItems']) {
        void resourceBindingFor(resource).cache.invalidateAll(queryClient)
      }
      close()
    } catch (e) {
      toastError('生成物料需求失败')(e)
    } finally {
      setRunning(false)
    }
  }

  const targetSelect = (
    value: TargetValue,
    onChange: (v: TargetValue) => void,
    ariaLabel: string,
    batch = false,
  ) => (
    <Select aria-label={ariaLabel} value={value} onChange={(v) => onChange((v ?? 'none') as TargetValue)}>
      <Select.Trigger className={batch ? 'h-7 min-w-28 text-xs' : 'h-8 text-sm'}>
        <Select.Value>
          {value === 'none' ? '不需要' : value === 'purchase' ? '采购' : (deptOptions.find((d) => d.id === value)?.name ?? value)}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          <ListBox.Item id="none" textValue="不需要">
            {batch ? '批量：不需要' : '不需要'}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          <ListBox.Item id="purchase" textValue="采购">
            {batch ? '批量：采购' : '采购'}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {deptOptions.map((d) => (
            <ListBox.Item key={d.id} id={d.id} textValue={d.name}>
              {batch ? `批量：${d.name}` : d.name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  )

  const dialog: ReactNode = (
    <>
      <Modal.Backdrop isOpen={pending !== null} onOpenChange={(open) => !open && close()}>
      <Modal.Container>
        <Modal.Dialog className="max-w-5xl" aria-label="生成物料需求">
          <Modal.Header>
            <Modal.Heading>
              生成物料需求{pending ? `（工单 ${String(pending.workOrderNo ?? '')}）` : ''}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {preview.isPending ? (
              <div className="flex h-48 items-center justify-center">
                <Spinner />
              </div>
            ) : preview.error ? (
              <EmptyState size="sm" className="h-48 justify-center">
                <EmptyState.Header>
                  <EmptyState.Title>物料需求取数失败</EmptyState.Title>
                  <EmptyState.Description>
                    {(preview.error as Error).message}
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            ) : lines.length === 0 ? (
              <EmptyState size="sm" className="h-48 justify-center">
                <EmptyState.Header>
                  <EmptyState.Title>
                    工单未挂 BOM 快照，无法生成物料需求
                  </EmptyState.Title>
                  <EmptyState.Description>
                    请先在工单上选入启用中 BOM 生成快照配料
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            ) : (
              <Table>
                <Table.ScrollContainer className="max-h-96">
                  <Table.Content aria-label="物料需求分流">
                    <Table.Header>
                      <Table.Column>物料</Table.Column>
                      <Table.Column>单位</Table.Column>
                      <Table.Column className="text-end">毛需求</Table.Column>
                      <Table.Column className="text-end">参考库存</Table.Column>
                      <Table.Column className="w-36 text-end">数量</Table.Column>
                      <Table.Column className="w-44">
                        <div className="flex items-center gap-2">
                          去向
                          {targetSelect(batchTarget, applyBatch, '批量设置去向', true)}
                        </div>
                      </Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {lines.map((l) => (
                        <Table.Row key={l.componentId}>
                          <Table.Cell>
                            <div className="flex min-w-0 flex-col gap-0.5 py-0.5 text-sm leading-snug">
                              <span className="truncate font-medium">
                                {l.materialCode} {l.materialName}
                              </span>
                              {l.materialSpec != null && l.materialSpec !== '' && (
                                <span className="truncate text-xs text-muted">
                                  规格 {l.materialSpec}
                                </span>
                              )}
                            </div>
                          </Table.Cell>
                          <Table.Cell>{l.unitName}</Table.Cell>
                          <Table.Cell className="text-end">
                            {formatQty(l.grossQty)}
                          </Table.Cell>
                          <Table.Cell className="text-end">
                            {formatQty(l.stockQty)}
                          </Table.Cell>
                          <Table.Cell className="text-end">
                            <NumberField
                              aria-label={`${l.materialName} 数量`}
                              value={l.qty}
                              minValue={0}
                              onChange={(v) =>
                                patchLine(l.componentId, {
                                  qty: Number.isFinite(v) ? v : 0,
                                })
                              }
                            >
                              <NumberField.Group>
                                <NumberField.Input className="text-end" />
                              </NumberField.Group>
                            </NumberField>
                          </Table.Cell>
                          <Table.Cell>
                            {targetSelect(
                              l.target,
                              (v) => patchLine(l.componentId, { target: v }),
                              `${l.materialName} 去向`,
                            )}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            )}
          </Modal.Body>
          <Modal.Footer>
            <span className="mr-auto text-sm text-muted">
              已选去向 {chosen.length} 行；未选「不需要」的行不带出
            </span>
            <Button variant="secondary" onPress={close} isDisabled={running}>
              取消
            </Button>
            <Button
              isPending={running}
              isDisabled={chosen.length === 0}
              onPress={() => void submit()}
            >
              生成需求单草稿
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
      </Modal.Backdrop>
      {/* 重复生成二次确认（票 04）：确认后带 force 重发 */}
      <AlertDialog.Backdrop
        isOpen={forceConfirm !== null}
        onOpenChange={(open) => !open && setForceConfirm(null)}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" aria-label="重复生成确认">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>再次生成物料需求？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                该工单已有未删除的派生需求单草稿（
                {(forceConfirm ?? []).join('、')}
                ），再次生成会产生重复草稿。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={running}>
                取消
              </Button>
              <Button
                variant="danger"
                isPending={running}
                onPress={() => {
                  setForceConfirm(null)
                  void submit(true)
                }}
              >
                仍然生成
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  )

  return {
    /** 打开弹窗：row 需带 id / companyId / workOrderNo（列表列已在白名单内） */
    requestGenerate: (row: Row) => {
      setLines([])
      setBatchTarget('none')
      setPending(row)
    },
    dialog,
  }
}
