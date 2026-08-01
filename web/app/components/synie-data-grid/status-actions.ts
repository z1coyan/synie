import { toast } from '@heroui/react'
import type { Row, RowAction } from './types'

/**
 * 启用/停用行动作对:规范「状态类开关不进创建/编辑表单,独立入口显式翻转」的标准实现。
 * 两个动作都按 update 权限门控;对已处于目标状态的行给警告不发请求。
 */
interface StatusToggleBase {
  /** 状态字段名(camel,如 active/enabled),读当前值、写翻转值都用它 */
  field: string
  /** toast 里的记录显示名,缺省取 row.name */
  rowLabel?: (row: Row) => string
  /** 成功后的额外刷新(组件自身 refetch 之外,如树页 remount、失效 rowById 缓存) */
  onDone?: () => void
}

export type StatusToggleOptions = StatusToggleBase & {
  /** 资源通过当前 ResourceBinding 更新。 */
  update: (id: string, input: Record<string, unknown>) => Promise<unknown>
}

export function statusToggleActions(opts: StatusToggleOptions): RowAction[] {
  const label = (row: Row) => String(opts.rowLabel?.(row) ?? row.name ?? '')

  const flip = (target: boolean, verb: string) => async (row: Row, ctx: { refetch: () => void }) => {
    if (Boolean(row[opts.field]) === target) {
      toast.warning(`「${label(row)}」已是${verb}状态`)
      return
    }
    try {
      await opts.update(row.id, { [opts.field]: target })
      toast.success(`已${verb}「${label(row)}」`)
      ctx.refetch()
      opts.onDone?.()
    } catch (e) {
      toast.danger(`${verb}失败`, { description: (e as Error).message })
    }
  }

  return [
    { key: 'statusEnable', label: '启用', capability: 'update', onAction: flip(true, '启用') },
    { key: 'statusDisable', label: '停用', capability: 'update', isDanger: true, onAction: flip(false, '停用') },
  ]
}
