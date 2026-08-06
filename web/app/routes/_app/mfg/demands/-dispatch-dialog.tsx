import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertDialog, Button, ListBox, Select, toast } from '@heroui/react'
import { RemoteSelect } from '~/components/synie-remote-select/RemoteSelect'
import type { Row } from '~/components/synie-data-grid/types'
import { resourceBindingFor } from '~/lib/resources/registry'
import { dispatchDemand } from '~/lib/resources/manufacturing'
import { toastError } from '~/lib/toast'

/**
 * 下发/改派弹窗（已确认未关闭的需求单行动作）：可同时改指派类型与下发车间，
 * 过与草稿表单相同的联动校验（类型=生产时车间必填，其余类型车间必须为空）。
 * 车间候选按需求单公司收窄且只取启用中的部门——与后端同公司硬校验同一口径。
 * 草稿态改派在表单里做，本弹窗只服务确认后的改派。
 */
const ASSIGN_TYPE_OPTIONS = [
  { value: 'PURCHASE', label: '采购' },
  { value: 'MAKE', label: '生产' },
  { value: 'STOCK', label: '库存' },
  { value: 'CLOSE', label: '关闭' },
] as const

export function useDispatchDemand() {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<{ row: Row; refetch: () => void } | null>(null)
  const [assignType, setAssignType] = useState<string>('PURCHASE')
  const [deptId, setDeptId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const close = () => {
    setPending(null)
    setDeptId(null)
  }

  const isMake = assignType === 'MAKE'

  const submit = async () => {
    if (!pending) return
    if (isMake && !deptId) return
    setRunning(true)
    try {
      await dispatchDemand(String(pending.row.id), {
        assignType,
        assignedDeptId: isMake ? deptId : null,
      })
      toast.success('已改派')
      await resourceBindingFor('mfgDemands').cache.invalidateAll(queryClient)
      pending.refetch()
      close()
    } catch (e) {
      toastError('改派失败')(e)
    } finally {
      setRunning(false)
    }
  }

  const companyId = pending?.row.companyId == null ? null : String(pending.row.companyId)

  const dispatchDialog = (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialog.Container>
        <AlertDialog.Dialog aria-label="下发/改派">
          <AlertDialog.Header>
            <AlertDialog.Icon status="accent" />
            <AlertDialog.Heading>下发/改派</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="mb-4 text-sm text-muted">
              指派类型=生产时需指定车间，下发后该车间即可看到本需求单并安排生产工单；其余类型不下发车间。
            </p>
            <div className="flex flex-col gap-3">
              <Select
                aria-label="指派类型"
                value={assignType}
                onChange={(v) => {
                  const next = String(v ?? 'PURCHASE')
                  setAssignType(next)
                  if (next !== 'MAKE') setDeptId(null)
                }}
              >
                <Select.Trigger className="h-9 text-sm">
                  <Select.Value>
                    {ASSIGN_TYPE_OPTIONS.find((o) => o.value === assignType)?.label ?? assignType}
                  </Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {ASSIGN_TYPE_OPTIONS.map((o) => (
                      <ListBox.Item key={o.value} id={o.value} textValue={o.label}>
                        {o.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <RemoteSelect
                resource="sysDepartments"
                label="车间"
                placeholder={isMake ? '选择本公司车间…' : '仅指派类型为生产时可填'}
                labelField="name"
                isRequired={isMake}
                isDisabled={!isMake}
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
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button slot="close" variant="tertiary" isDisabled={running}>
              取消
            </Button>
            <Button
              variant="primary"
              isPending={running}
              isDisabled={isMake && deptId == null}
              onPress={() => void submit()}
            >
              确认改派
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  )

  return {
    /** 打开弹窗：row 需带 companyId、assignType 与 assignedDeptId（列表列已在白名单内） */
    requestDispatch: (row: Row, refetch: () => void) => {
      setPending({ row, refetch })
      setAssignType(row.assignType == null ? 'PURCHASE' : String(row.assignType))
      setDeptId(row.assignedDeptId == null ? null : String(row.assignedDeptId))
    },
    dispatchDialog,
  }
}
