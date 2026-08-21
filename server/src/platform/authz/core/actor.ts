import type { ScopeSet } from './scope.ts'

/**
 * Actor v2（判定内核唯一主体表示，零 IO / 零表知识）。
 *
 * grants 为**精确码**映射（无通配）：装配层已把 `sys_role.grants_all` 展开为全目录 all 范围。
 * username / name 只是身份元数据（审计与 /auth/me 消费），decide 不读取。
 */
export interface Actor {
  /** user=终端用户请求；system=调度器/种子/跨模块受信任读（经 systemPermit 取得） */
  kind: 'user' | 'system'
  userId: string
  username: string
  name: string | null
  /** 超级管理员：绕过一切功能与数据权限 */
  superAdmin: boolean
  /** 公司授权：all=true 即不做公司过滤（用户级 all_companies 旗标折叠进来） */
  companies: { all: boolean; ids: readonly string[] }
  /** 所属部门（至多一个）；null=无部门，dept/deptTree 范围编译为空集 */
  deptId: string | null
  /** 部门子树（含本部门），装配时按 sys_department.path 物化 */
  deptSubtreeIds: readonly string[]
  /** 精确权限码 → 范围位集 */
  grants: ReadonlyMap<string, ScopeSet>
}

/**
 * 码持有查询：superAdmin/system 恒真，否则查精确码。
 * 仅供**呈现投影**（如 Registry.canRead 决定文档是否可见）使用；
 * 授权判定唯一入口是 decide()，本函数不产生任何行级语义。
 */
export function hasPermission(actor: Actor | null, code: string): boolean {
  if (!actor) return false
  if (actor.superAdmin || actor.kind === 'system') return true
  return actor.grants.has(code)
}

/** system 主体的固定身份（无用户行；不设 superAdmin，靠 kind 旁路） */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'

export function systemActor(): Actor {
  return {
    kind: 'system',
    userId: SYSTEM_USER_ID,
    username: 'system',
    name: '系统',
    superAdmin: false,
    companies: { all: true, ids: [] },
    deptId: null,
    deptSubtreeIds: [],
    grants: new Map(),
  }
}
