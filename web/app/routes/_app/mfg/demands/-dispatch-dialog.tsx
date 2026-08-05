import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, toast } from '@heroui/react'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceBindingFor } from '~/lib/resources/registry'
import { dispatchDemand } from '~/lib/resources/manufacturing'
import { toastError } from '~/lib/toast'

/**
 * 下发/改派车间弹窗（已确认未关闭的需求单行动作）。
 * 车间候选按需求单公司收窄且只取启用中的部门——与后端同公司硬校验同一口径。
 * 草稿态改车间在表单里做，本弹窗只服务确认后的改派。
 */
export function useDispatchDemand() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<{ row: Row; refetch: () => void } | null>(null)
  const [deptId, setDeptId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const close = () => {
    setPending(null)
    setDeptId(null)
  }

  const submit = async () => {
    if (!pending || !deptId) return
    setRunning(true)
    try {
      await dispatchDemand(String(pending.row.id), deptId)
      toast.success('已下发车间')
      await resourceBindingFor('mfgDemands').cache.invalidateAll(queryClient)
      pending.refetch()
      close()
    } catch (e) {
      toastError('下发车间失败')(e)
    } finally {
      setRunning(false)
    }
  }

  const companyId = pending?.row.companyId == null ? null : String(pending.row.companyId)

  const dispatchDialog = (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialog.Container>
        <AlertDialog.Dialog aria-label="下发车间">
          <AlertDialog.Header>
            <AlertDialog.Icon status="accent" />
            <AlertDialog.Heading>下发车间</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="mb-4 text-sm text-muted">
              下发后该车间即可看到本需求单并安排生产工单；改派会让原车间不再可见。
            </p>
            <RemoteSelect
              resource="sysDepartments"
              label="车间"
              placeholder="选择本公司车间…"
              labelField="name"
              isRequired
              value={deptId}
              onChange={(id) => setDeptId(id)}
              filterState={
                companyId
                  ? {
                      companyId: { kind: 'fk', op: 'in', values: [companyId], labels: [] },
                      enabled: { kind: 'bool', eq: true },
                    }
                  : undefined
              }
            />
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="tertiary" isDisabled={running}>
              取消
            </Button>
            <Button
              variant="primary"
              isPending={running}
              isDisabled={deptId == null}
              onPress={() => void submit()}
            >
              确认下发
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  return {
    /** 打开弹窗：row 需带 companyId 与 assignedDeptId（列表列已在白名单内） */
    requestDispatch: (row: Row, refetch: () => void) => {
      setPending({ row, refetch })
      setDeptId(row.assignedDeptId == null ? null : String(row.assignedDeptId))
    },
    dispatchDialog,
  }
}
