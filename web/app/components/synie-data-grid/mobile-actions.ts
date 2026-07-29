/** 卡片模式动作面:toolbar=工具栏,bulk=批量条,row=行内 ⋯ 菜单 */
export type CardActionSurface = 'toolbar' | 'bulk' | 'row'

/**
 * 卡片模式动作显隐判定:
 * - 行内菜单默认全保留,`mobile: false` 拿下(如行内打印);
 * - 工具栏/批量默认全隐藏,`mobile: true` 放上(如移动审批);
 * - 未声明 mobile 严格走默认。
 */
export function visibleOnCard<T extends { mobile?: boolean }>(actions: T[], surface: CardActionSurface): T[] {
  return actions.filter((a) => (surface === 'row' ? a.mobile !== false : a.mobile === true))
}
