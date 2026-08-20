/**
 * 权限动作收口：封闭八动作 + 旧码兼容映射。
 *
 * 目录 / 路由 / 矩阵只认八动作。存量 `sys_role_permission` 行仍可能写着
 * close/confirm/batch_* 等旧码——装配 Actor 时折到新码，旧行不删、不改库。
 * generate_* 已从源单动作移除（改走 mfg.demand:create），旧行不授权任何行为。
 */
export const CANONICAL_ACTIONS = [
  'read',
  'create',
  'update',
  'audit',
  'delete',
  'void',
  'export',
  'print',
] as const

export type CanonicalAction = (typeof CANONICAL_ACTIONS)[number]

export const CANONICAL_ACTION_SET: ReadonlySet<string> = new Set(CANONICAL_ACTIONS)

/**
 * 旧动作码 → 八动作。键是权限码冒号后的动作段。
 * 未列出的旧码若不是八动作之一，装配时丢弃（不授权）。
 */
export const FOLDED_ACTIONS: Readonly<Record<string, CanonicalAction>> = {
  close: 'audit',
  cancel: 'void',
  approve: 'audit',
  activate: 'update',
  deactivate: 'update',
  setDefault: 'update',
  unsetDefault: 'update',
  batch_update: 'update',
  batch_delete: 'delete',
  batch_print: 'print',
  confirm: 'audit',
  unconfirm: 'update',
  import: 'create',
  // 红冲开新红字单，原单保留；能力是新增，仅作废不能红冲
  reverse: 'create',
  ship: 'audit',
  receive: 'audit',
  dispatch: 'update',
  // 日考勤重算 / 银行流水勾稽：未单列折叠，归入编辑（不是第九动作）
  recalc: 'update',
  reconcile: 'update',
}

/** 已从源单动作移除：旧授权行保留但不授权 */
export const REMOVED_ACTIONS: ReadonlySet<string> = new Set([
  'generate_replenishment',
  'generate_material_demand',
])

export function foldAction(action: string): CanonicalAction | null {
  if (REMOVED_ACTIONS.has(action)) return null
  if (CANONICAL_ACTION_SET.has(action)) return action as CanonicalAction
  return FOLDED_ACTIONS[action] ?? null
}

/**
 * 完整权限码折叠。无法折叠（已移除或未知旧码）返回 null——装配层跳过，不授权。
 */
export function foldPermissionCode(code: string): string | null {
  const sep = code.lastIndexOf(':')
  if (sep < 0) return null
  const folded = foldAction(code.slice(sep + 1))
  if (!folded) return null
  return `${code.slice(0, sep)}:${folded}`
}
