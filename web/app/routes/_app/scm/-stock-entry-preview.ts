import type { GridColumnMeta, Row } from '~/components/synie-data-grid/types'
import { resolveFkTarget } from '~/components/synie-remote-select/remote-query'

/**
 * 来源单号必须复用 voucherId 的权限裁剪后多态元数据：目标变体不可见时返回 null，
 * 让单号退为纯文本，避免静态资源映射制造一个注定 403 的假链接。
 */
export function resolveVoucherPreviewTarget(
  voucherIdColumn: GridColumnMeta | undefined,
  row: Row,
): { resource: string; labelField: string } | null {
  return voucherIdColumn?.ref ? resolveFkTarget(voucherIdColumn.ref, row) : null
}
