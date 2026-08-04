import { sql, type Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'

/** 单次装配所需的授权事实（无缓存、无展开；展开在 assembler） */
export interface ActorFacts {
  userId: string
  username: string
  name: string | null
  superAdmin: boolean
  allCompanies: boolean
  /** 任一启用角色持全域授权旗标 */
  grantsAll: boolean
  /** 精确权限码 + 授权范围（`sys_role_permission.scope` 原值） */
  grants: readonly { permission: string; scope: string }[]
  companyIds: readonly string[]
  deptId: string | null
  /** 部门子树（含本部门），按 sys_department.path 前缀物化 */
  deptSubtreeIds: readonly string[]
}

/**
 * 授权存储读取面（authz 环拥有）：用户行 + 角色授权（含 scope）+ 公司集 + 部门子树。
 * 组织树是 IAM 的主数据，本层只读「用户 → 部门子树」窄接口，不写不校验。
 */
export function createAuthzStore(db: Kysely<Database>) {
  async function factsByUserId(userId: string): Promise<ActorFacts | null> {
    const base = await db
      .selectFrom('sys_user')
      .select([
        'id',
        'name',
        'super_admin as superAdmin',
        'all_companies as allCompanies',
        'department_id as deptId',
      ])
      .select(sql<string>`username::text`.as('username'))
      .where('id', '=', userId)
      .executeTakeFirst()
    if (!base) return null

    const [grantRows, companyRows, grantsAllRow, subtreeRows] = await Promise.all([
      db
        .selectFrom('sys_user_role as ur')
        .innerJoin('sys_role as r', (join) =>
          join.onRef('r.id', '=', 'ur.role_id').on('r.enabled', '=', true),
        )
        .innerJoin('sys_role_permission as rp', 'rp.role_id', 'r.id')
        .select(['rp.permission', 'rp.scope'])
        .where('ur.user_id', '=', userId)
        .distinct()
        .orderBy('rp.permission')
        .orderBy('rp.scope')
        .execute(),
      db
        .selectFrom('sys_user_company')
        .select('company_id as companyId')
        .where('user_id', '=', userId)
        .orderBy('company_id')
        .execute(),
      db
        .selectFrom('sys_user_role as ur')
        .innerJoin('sys_role as r', (join) =>
          join
            .onRef('r.id', '=', 'ur.role_id')
            .on('r.enabled', '=', true)
            .on('r.grants_all', '=', true),
        )
        .select('r.id')
        .where('ur.user_id', '=', userId)
        .executeTakeFirst(),
      base.deptId ? deptSubtree(db, base.deptId) : Promise.resolve([]),
    ])

    return {
      userId: base.id,
      username: base.username,
      name: base.name,
      superAdmin: base.superAdmin,
      allCompanies: base.allCompanies,
      grantsAll: grantsAllRow !== undefined,
      grants: grantRows.map((row) => ({ permission: row.permission, scope: row.scope })),
      companyIds: companyRows.map((row) => row.companyId),
      deptId: base.deptId,
      deptSubtreeIds: subtreeRows,
    }
  }

  return { factsByUserId }
}

export type AuthzStore = ReturnType<typeof createAuthzStore>

/** 部门子树（含本部门）：按物化路径前缀匹配；节点不存在时返回空数组 */
async function deptSubtree(db: Kysely<Database>, deptId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT d.id
    FROM sys_department d
    JOIN sys_department self ON self.id = ${deptId}::uuid
    WHERE d.path LIKE self.path || '%'
    ORDER BY d.path
  `.execute(db)
  return rows.rows.map((row) => row.id)
}
