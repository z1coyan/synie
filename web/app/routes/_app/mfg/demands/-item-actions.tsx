import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertDialog,
  Button,
  Label,
  ListBox,
  Modal,
  Select,
  toast,
} from '@heroui/react'
import { useGridMeta } from '~/components/synie-data-grid/meta'
import type { Row } from '~/components/synie-data-grid/types'
import { fetchMyPermissions } from '~/lib/permissions'
import {
  changeDemandItemFulfillment,
  completeDemandItem,
  demandItemClient,
  workOrderClient,
} from '~/lib/resources/manufacturing'

/**
 * 需求行行级操作(US 12/14-16、自制行生成工单):完成 / 改履约方式 / 生成工单。
 * 条目视图(SynieDataGrid rowActions)与需求单抽屉(SynieEditableTable rowActions)
 * 共用同一套 mutation、确认弹窗与 toast;after 回调由使用方注入(刷新当下列表)。
 */

/** 行显隐(体验层;需求单状态/下游工单等权威校验在后端,失败经 toast 呈现) */
// 已下单(orderedQty>0)的行须等入库回写,不展示点完成
export const canCompleteItem = (row: Row) =>
  row.status === 'PENDING' &&
  row.fulfillmentMethod !== 'MAKE' &&
  !(Number(row.orderedQty) > 0)
export const canChangeFulfillmentItem = (row: Row) => row.status !== 'COMPLETED'
export const canGenerateWorkOrder = (row: Row) =>
  row.fulfillmentMethod === 'MAKE' && row.status === 'PENDING'

/** 当前用户权限集(other-stock 页同一取法;60s 缓存) */
export function useMyPermissions() {
  return useQuery({
    queryKey: ['myPermissions'],
    queryFn: fetchMyPermissions,
    staleTime: 60_000,
  })
}

const rowLabel = (row: Row) =>
  String(row.materialName ?? row.materialCode ?? '该需求行')

type Pending = { kind: 'complete' | 'generate' | 'change'; row: Row }

export function useDemandItemActions(after: () => void) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Pending | null>(null)
  const [method, setMethod] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const meta = useGridMeta('mfgDemandItems', true)
  const methodOptions =
    meta.data?.columns.find((c) => c.name === 'fulfillmentMethod')
      ?.enumOptions ?? []

  const done = () => {
    // 行状态变化会影响需求行/工单两个网格与抽屉行数据
    queryClient.invalidateQueries({ queryKey: ['gridRows'] })
    queryClient.invalidateQueries({ queryKey: ['rowById'] })
    after()
  }

  const run = async (fn: () => Promise<void>) => {
    setRunning(true)
    try {
      await fn()
    } finally {
      setRunning(false)
    }
  }

  const confirmComplete = () =>
    run(async () => {
      const row = pending!.row
      try {
        await completeDemandItem(row.id)
        toast.success(`「${rowLabel(row)}」已完成`)
        setPending(null)
        done()
      } catch (e) {
        toast.danger('完成失败', { description: (e as Error).message })
      }
    })

  const confirmGenerate = () =>
    run(async () => {
      const row = pending!.row
      try {
        const created = await workOrderClient.create({
          demandItemId: row.id,
          workOrderNo: null,
        })
        toast.success(`生产工单已生成(${String(created.workOrderNo ?? '')})`)
        setPending(null)
        done()
      } catch (e) {
        toast.danger('生成工单失败', { description: (e as Error).message })
      }
    })

  const confirmChange = () =>
    run(async () => {
      const row = pending!.row
      try {
        await changeDemandItemFulfillment(row.id, method!)
        toast.success(`「${rowLabel(row)}」履约方式已改`)
        setPending(null)
        done()
      } catch (e) {
        toast.danger('改履约方式失败', { description: (e as Error).message })
      }
    })

  const confirmDialog = (
    kind: 'complete' | 'generate',
    title: string,
    body: string,
    onConfirm: () => void,
  ) => (
    <AlertDialog.Backdrop
      isOpen={pending?.kind === kind}
      onOpenChange={(open) => !open && setPending(null)}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog className="sm:max-w-[400px]" aria-label={title}>
          {pending?.kind === kind && (
            <>
              <AlertDialog.Header>
                <AlertDialog.Icon status="accent" />
                <AlertDialog.Heading>{title}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>{body}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary" isDisabled={running}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={running}
                  onPress={onConfirm}
                >
                  确认
                </Button>
              </AlertDialog.Footer>
            </>
          )}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  // 渲染为已成型元素而非组件函数(同 use-grid-actions confirmDialog 注释:避免子树重挂载)
  const dialogs: ReactNode = (
    <>
      {confirmDialog(
        'complete',
        '确认完成?',
        `将把「${pending?.kind === 'complete' ? rowLabel(pending.row) : ''}」标为已完成,该行离开待办。`,
        () => void confirmComplete(),
      )}
      {confirmDialog(
        'generate',
        '确认生成工单?',
        `将按「${pending?.kind === 'generate' ? rowLabel(pending.row) : ''}」的数量生成一张生产工单(单号自动取号)。`,
        () => void confirmGenerate(),
      )}
      <Modal.Backdrop
        isOpen={pending?.kind === 'change'}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <Modal.Container>
          <Modal.Dialog className="max-w-md" aria-label="改履约方式">
            {pending?.kind === 'change' && (
              <>
                <Modal.Header>
                  <Modal.Heading>改履约方式</Modal.Heading>
                </Modal.Header>
                <Modal.Body>
                  <p className="mb-3 text-sm text-muted">
                    「{rowLabel(pending.row)}
                    」的新履约方式(已有未作废工单或已完成行不可改,后端权威校验)。
                  </p>
                  <Select
                    value={method}
                    onChange={(v) => setMethod(v === '' ? null : String(v))}
                  >
                    <Label>履约方式</Label>
                    <Select.Trigger>
                      <Select.Value>
                        {({ isPlaceholder, defaultChildren }) =>
                          isPlaceholder ? '请选择…' : defaultChildren
                        }
                      </Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {methodOptions.map((o) => (
                          <ListBox.Item
                            key={o.value}
                            id={o.value}
                            textValue={o.label}
                          >
                            {o.label}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </Modal.Body>
                <Modal.Footer>
                  <Button
                    variant="secondary"
                    isDisabled={running}
                    onPress={() => setPending(null)}
                  >
                    取消
                  </Button>
                  <Button
                    isPending={running}
                    isDisabled={
                      !method || method === pending.row.fulfillmentMethod
                    }
                    onPress={() => void confirmChange()}
                  >
                    确认
                  </Button>
                </Modal.Footer>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  )

  return {
    requestComplete: (row: Row) => setPending({ kind: 'complete', row }),
    requestGenerate: (row: Row) => setPending({ kind: 'generate', row }),
    requestChange: (row: Row) => {
      setMethod(
        row.fulfillmentMethod == null ? null : String(row.fulfillmentMethod),
      )
      setPending({ kind: 'change', row })
    },
    dialogs,
  }
}
