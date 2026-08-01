import type { AggregateDraftAdapter } from './catalog/types'
import { aggregateDraftId } from './aggregate-draft-rows'

/**
 * 完整替换只能在权威聚合草稿加载完成后提交。
 *
 * create 没有既有子树，可直接从显式空集合开始；edit 的 pending 与 failed 都保持
 * detailLoaded=false，禁止把暂态空数组解释为“删除全部子记录”。
 */
export function assertAggregateDraftReady(
  mode: 'create' | 'edit',
  detailLoaded: boolean,
  detailLabel = '明细',
): void {
  if (mode === 'edit' && !detailLoaded) {
    throw new Error(`${detailLabel}尚未完整加载，不能提交整单替换`)
  }
}

/** 路由提交的唯一原子写入口；成功时返回可直接交给“保存并审核”的权威 id。 */
export async function submitAggregateDraft(
  adapter: AggregateDraftAdapter,
  mode: 'create' | 'edit',
  existingId: string | null | undefined,
  input: unknown,
  label: string,
): Promise<string> {
  if (mode === 'edit' && (typeof existingId !== 'string' || existingId.trim() === '')) {
    throw new Error(`${label}缺少待替换记录 id`)
  }
  const saved = mode === 'create'
    ? await adapter.createDraft(input)
    : await adapter.replaceDraft(existingId!, input)
  return aggregateDraftId(saved, label)
}
