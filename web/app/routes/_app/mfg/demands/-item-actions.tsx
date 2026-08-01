import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, toast } from '@heroui/react'
import type { Row } from '~/components/synie-data-grid/types'
import { fetchMyPermissions } from '~/lib/permissions'
import { toastError } from '~/lib/toast'
import { workOrderClient } from '~/lib/resources/manufacturing'
import { resourceBindingFor } from '~/lib/resources/registry'

/**
 * 需求行行级操作：生成工单（分批可多张）。
 * 完成语义走安排/入库双投影，不再提供「点完成 / 改履约方式」。
 */

/** 有剩余可安排且未完成时可生成工单（后端权威校验） */
export const canGenerateWorkOrder = (row: Row) => {
  if (row.status === 'COMPLETED') return false
  const rem = Number(
    row.remainingArrangeableQty ?? row.remainingOrderableQty ?? NaN,
  )
  if (Number.isFinite(rem)) return rem > 0
  return row.status === 'PENDING' || row.status === 'SCHEDULED'
}

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

type Pending = { kind: 'generate'; row: Row }

export function useDemandItemActions(after: () => void) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<Pending | null>(null)
  const [running, setRunning] = useState(false)

  const done = () => {
    for (const resource of ['mfgWorkOrders', 'mfgDemandItems', 'mfgDemands']) {
      void resourceBindingFor(resource).cache.invalidateAll(queryClient)
    }
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
        toastError('生成工单失败')(e)
      }
    })

  // 渲染为已成型元素而非组件函数(同 use-grid-actions confirmDialog 注释:避免子树重挂载)
  const dialogs: ReactNode = (
    <AlertDialog.Backdrop
      isOpen={pending?.kind === 'generate'}
      onOpenChange={(open) => !open && setPending(null)}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog
          className="sm:max-w-[400px]"
          aria-label="确认生成工单?"
        >
          {pending?.kind === 'generate' && (
            <>
              <AlertDialog.Header>
                <AlertDialog.Icon status="accent" />
                <AlertDialog.Heading>确认生成工单?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>
                  将按「{rowLabel(pending.row)}
                  」的剩余可安排数量默认生成一张生产工单(单号自动取号；可在工单上改数量)。
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary" isDisabled={running}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={running}
                  onPress={() => void confirmGenerate()}
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

  return {
    requestGenerate: (row: Row) => setPending({ kind: 'generate', row }),
    dialogs,
  }
}
