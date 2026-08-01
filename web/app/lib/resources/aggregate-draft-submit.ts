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
