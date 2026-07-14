import type { Row } from '~/components/synie-data-grid/types'

export interface ReconcileDrawerProps {
  txn: Row | null
  onOpenChange: (open: boolean) => void
  /** 任一对账变更后回调(父列表刷新) */
  onChanged: () => void
}

// Task 7 实现完整抽屉;先占位保证页面接线可编译
export function ReconcileDrawer(_props: ReconcileDrawerProps) {
  return null
}
