/**
 * 部门（组织树主数据，IAM 拥有）——标准派生服务（platform/standard）+ 内核树能力。
 *
 * 新授权体系（工单 05）的首个业务消费者：路由挂 `guard`，服务只收 Permit——
 * 列表/单条/写侧三个执行点由平台拥有（内核经 listAuthorized / loadAuthorizedFrom /
 * loadAuthorized(forUpdate) / assertCompanyWritable 编排），模块内零鉴权代码。
 *
 * 树形一致性由内核 `tree` 承接（语义逐字来自本文件的手写实现）：
 * - 公司域 advisory 树锁（`sys_department:{公司id}`），树锁先于行锁
 * - 父子校验：自身 / 不存在 / 跨公司（内核内置）；「上级已停用」是本资源个性不变量，走 onParent
 * - 物化路径列 `path`（`/{祖先id}/…/{本id}/`），移动节点即改写整棵子树
 * - 有下级部门不可删（内核缺省文案即「存在下级部门,不能删除」）
 *
 * 「仍有用户挂在该部门」是跨资源引用保护，走 beforeDelete 钩子。
 * 展示投影（公司对象 / 上级对象 / hasChildren）走 projection。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { DEPARTMENT_RESOURCE } from './meta.ts'

export interface Department {
  id: string
  code: string
  name: string
  enabled: boolean
  insertedAt: Date
  updatedAt: Date
  companyId: string
  parentId: string | null
  company: { id: string; name: string; code?: string | null }
  parent: { id: string; name: string } | null
  hasChildren: boolean
  [key: string]: unknown
}

export type DepartmentService = StandardService<Department>

/** 列表与单条共用的投影（公司名、上级名、是否有下级） */
const SOURCE = sql`
  FROM (
    SELECT d.id, d.code, d.name, d.enabled, d.inserted_at, d.updated_at,
           d.company_id, d.parent_id,
           company.code AS company_code, company.name AS company_name,
           parent.name AS parent_name,
           EXISTS(SELECT 1 FROM sys_department child WHERE child.parent_id = d.id) AS has_children
    FROM sys_department d
    JOIN bas_company company ON company.id = d.company_id
    LEFT JOIN sys_department parent ON parent.id = d.parent_id
  ) department
`
const ALIAS = 'department'
const SELECT_EXTRA = sql`company_code, company_name, parent_name, has_children`

const WRITE_CONFLICTS = [
  { code: '23505', constraint: 'sys_department_company_code_index', message: '部门编码已存在' },
  { code: '23505', message: '部门唯一字段已存在' },
  { code: '23503', message: '部门已被引用或关联目标不存在' },
] as const

export function createDepartmentService(db: Kysely<Database>, registry: Registry): DepartmentService {
  return createStandardService<Department>({
    db,
    registry,
    resource: DEPARTMENT_RESOURCE,
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: WRITE_CONFLICTS,
    tree: {
      pathColumn: 'path',
      // 停用的部门不得作为上级（存量挂接保留，见 iam 用户写侧校验）
      onParent: (_trx, { parent }) => {
        if (!parent.enabled) {
          throw ApiError.validation('部门参数不合法', { parentId: ['上级部门已停用'] })
        }
      },
    },
    projection: {
      source: SOURCE,
      alias: ALIAS,
      selectExtra: SELECT_EXTRA,
      mapExtra: (row) => {
        const parentId = row.parent_id == null ? null : String(row.parent_id)
        const parentName = row.parent_name == null ? null : String(row.parent_name)
        return {
          company: {
            id: String(row.company_id),
            name: String(row.company_name),
            code: row.company_code == null ? null : String(row.company_code),
          },
          parent: parentId && parentName !== null ? { id: parentId, name: parentName } : null,
          hasChildren: Boolean(row.has_children),
        }
      },
    },
    hooks: {
      // 删除保护：下级部门由内核树能力挡；用户挂靠是跨资源引用，留在模块
      beforeDelete: async (trx, { item }) => {
        const attached = await trx
          .selectFrom('sys_user')
          .select('id')
          .where('department_id', '=', String(item.id))
          .executeTakeFirst()
        if (attached) throw new ApiError('conflict', '仍有用户挂在该部门,请先调整用户部门')
      },
    },
  })
}
