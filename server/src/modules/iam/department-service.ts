/**
 * 部门（组织树主数据，IAM 拥有）。
 *
 * 新授权体系（工单 05）的首个业务消费者：路由挂 `guard`，本服务只收 Permit——
 * 列表 `listAuthorized`、单条 `loadAuthorizedFrom` / `loadAuthorized`、写侧 `assertCompanyWritable`，
 * 模块内零鉴权代码。树形一致性（物化路径、成环、跨公司父级）是领域不变量，留在这里。
 */
import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { mapWriteError } from '~/db/dberr.ts'
import { listAuthorized } from '~/db/list.ts'
import { assertCompanyWritable, loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { auditCreated, auditDestroyed, auditDiff, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { DEPARTMENT_RESOURCE, departmentResourceMeta } from './meta.ts'

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
}

export interface DepartmentInput {
  code: string
  name: string
  companyId: string
  parentId?: string | null
}

export interface DepartmentPatch {
  code?: string
  name?: string
  enabled?: boolean
  parentId?: string | null
  /** PATCH 语义：只有显式给出 parentId 才动上级（区分「不改」与「置空」） */
  parentIdPresent?: boolean
}

const META = departmentResourceMeta()
const TABLE = META.table
const AUDIT = auditFieldsOf(META)

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
const SELECT = sql`SELECT id, code, name, enabled, inserted_at, updated_at, company_id, parent_id,
  company_code, company_name, parent_name, has_children`

const WRITE_CONFLICTS = [
  { code: '23505', constraint: 'sys_department_company_code_index', message: '部门编码已存在' },
  { code: '23505', message: '部门唯一字段已存在' },
  { code: '23503', message: '部门已被引用或关联目标不存在' },
] as const

export function createDepartmentService(db: Kysely<Database>, registry: Registry) {
  const target = registry.authzTarget(DEPARTMENT_RESOURCE)

  async function get(permit: Permit, id: string): Promise<Department> {
    return loadAuthorizedFrom({
      db,
      permit,
      target,
      alias: ALIAS,
      source: SOURCE,
      select: SELECT,
      id,
      mapRow,
      notFoundMessage: '部门不存在',
    })
  }

  async function list(permit: Permit, query: Partial<ListQuery>) {
    return listAuthorized({
      db,
      permit,
      target,
      alias: ALIAS,
      resource: META,
      source: SOURCE,
      select: SELECT,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow,
    })
  }

  async function create(permit: Permit, input: DepartmentInput): Promise<Department> {
    assertCompanyWritable(permit, input.companyId, '公司不存在')
    const code = input.code.trim()
    const name = input.name.trim()
    validateCodeAndName(code, name)
    const parentId = input.parentId ?? null
    return withTx(db, async (trx) => {
      await lockCompanyTree(trx, input.companyId)
      const parent = await resolveParent(trx, input.companyId, null, parentId)
      const id = crypto.randomUUID()
      try {
        await trx
          .insertInto('sys_department')
          .values({
            id,
            company_id: input.companyId,
            parent_id: parentId,
            code,
            name,
            path: childPath(parent?.path ?? null, id),
          })
          .execute()
      } catch (err) {
        throw mapWriteError(err, '创建部门失败', WRITE_CONFLICTS)
      }
      const item = await getInTx(trx, id)
      await writeAudit(trx, permit.actor, {
        resource: TABLE,
        recordId: id,
        recordLabel: item.name,
        actionType: 'create',
        actionName: 'create',
        companyId: item.companyId,
        changes: auditCreated(snap(item), AUDIT),
      })
      return item
    })
  }

  async function update(permit: Permit, id: string, patch: DepartmentPatch): Promise<Department> {
    return withTx(db, async (trx) => {
      await lockCompanyTree(trx, await companyOf(trx, id))
      const locked = await lockRow(trx, permit, id)
      const before = await getInTx(trx, id)
      const code = (patch.code ?? before.code).trim()
      const name = (patch.name ?? before.name).trim()
      validateCodeAndName(code, name)
      const enabled = patch.enabled ?? before.enabled
      const parentId = patch.parentIdPresent ? (patch.parentId ?? null) : before.parentId

      const moved = parentId !== before.parentId
      let newPath = locked.path
      if (moved) {
        const parent = await resolveParent(trx, before.companyId, id, parentId, locked.path)
        newPath = childPath(parent?.path ?? null, id)
      }

      const after: Department = { ...before, code, name, enabled, parentId }
      const changes = auditDiff(snap(before), snap(after), AUDIT)
      if (Object.keys(changes).length === 0) return before

      try {
        await trx
          .updateTable('sys_department')
          .set({
            code,
            name,
            enabled,
            parent_id: parentId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mapWriteError(err, '更新部门失败', WRITE_CONFLICTS)
      }
      // 移动节点即改写整棵子树的物化路径（含自身：oldPath 处的后缀为空串）
      if (moved) {
        // ::int 必须显式：无类型参数会让 PG 选中 substring(text FROM text) 的正则重载
        await sql`
          UPDATE sys_department
          SET path = ${newPath} || substring(path FROM ${locked.path.length + 1}::int),
              updated_at = (now() AT TIME ZONE 'utc')
          WHERE path LIKE ${locked.path} || '%'
        `.execute(trx)
      }

      const updated = await getInTx(trx, id)
      await writeAudit(trx, permit.actor, {
        resource: TABLE,
        recordId: id,
        recordLabel: updated.name,
        actionType: 'update',
        actionName: 'update',
        companyId: updated.companyId,
        changes,
      })
      return updated
    })
  }

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      await lockCompanyTree(trx, await companyOf(trx, id))
      await lockRow(trx, permit, id)
      const item = await getInTx(trx, id)
      if (item.hasChildren) throw new ApiError('conflict', '存在下级部门,不能删除')
      const attached = await trx
        .selectFrom('sys_user')
        .select('id')
        .where('department_id', '=', id)
        .executeTakeFirst()
      if (attached) throw new ApiError('conflict', '仍有用户挂在该部门,请先调整用户部门')
      try {
        await trx.deleteFrom('sys_department').where('id', '=', id).execute()
      } catch (err) {
        throw mapWriteError(err, '删除部门失败', WRITE_CONFLICTS)
      }
      await writeAudit(trx, permit.actor, {
        resource: TABLE,
        recordId: id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        companyId: item.companyId,
        changes: auditDestroyed(snap(item), AUDIT),
      })
    })
  }

  /** 授权闸 + 行锁；不命中一律 not_found（不泄露存在性）。返回物化路径（子树重算基准） */
  async function lockRow(trx: DbHandle, permit: Permit, id: string): Promise<{ path: string }> {
    const row = await loadAuthorized({
      db: trx,
      permit,
      target,
      table: TABLE,
      id,
      forUpdate: true,
      notFoundMessage: '部门不存在',
    })
    return { path: String(row.path) }
  }

  return { get, list, create, update, remove }
}

export type DepartmentService = ReturnType<typeof createDepartmentService>

async function getInTx(db: DbHandle, id: string): Promise<Department> {
  const rows = await sql<Record<string, unknown>>`
    ${SELECT}${SOURCE} WHERE department.id = ${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) throw new ApiError('not_found', '部门不存在')
  return mapRow(rows.rows[0]!)
}

/** 物化路径：`/{祖先id}/…/{本id}/`；一级部门即 `/{id}/` */
function childPath(parentPath: string | null, id: string): string {
  return `${parentPath ?? '/'}${id}/`
}

function mapRow(r: Record<string, unknown>): Department {
  const parentId = r.parent_id == null ? null : String(r.parent_id)
  const parentName = r.parent_name == null ? null : String(r.parent_name)
  return {
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    enabled: Boolean(r.enabled),
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    companyId: String(r.company_id),
    parentId,
    company: {
      id: String(r.company_id),
      name: String(r.company_name),
      code: r.company_code == null ? null : String(r.company_code),
    },
    parent: parentId && parentName !== null ? { id: parentId, name: parentName } : null,
    hasChildren: Boolean(r.has_children),
  }
}

function snap(item: Department): Record<string, unknown> {
  return {
    code: item.code,
    name: item.name,
    enabled: item.enabled,
    company_id: item.companyId,
    parent_id: item.parentId,
  }
}

function validateCodeAndName(code: string, name: string): void {
  const fields: Record<string, string[]> = {}
  if (!code || runeLen(code) > 32) fields.code = ['不能为空且最多 32 个字符']
  if (!name || runeLen(name) > 64) fields.name = ['不能为空且最多 64 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('部门参数不合法', fields)
  }
}

/**
 * 上级部门校验（同公司 / 未停用 / 不成环），返回父行以拼路径。
 * @param selfPath 移动场景传本节点物化路径，用于「不得移到自身后代」判定
 */
async function resolveParent(
  db: DbHandle,
  companyId: string,
  selfId: string | null,
  parentId: string | null,
  selfPath?: string,
): Promise<{ id: string; path: string } | null> {
  if (parentId === null) return null
  if (selfId !== null && parentId === selfId) {
    throw ApiError.validation('部门参数不合法', { parentId: ['上级部门不能选择自身'] })
  }
  const parent = await db
    .selectFrom('sys_department')
    .select(['id', 'path', 'company_id', 'enabled'])
    .where('id', '=', parentId)
    .executeTakeFirst()
  if (!parent) {
    throw ApiError.validation('部门参数不合法', { parentId: ['上级部门不存在'] })
  }
  if (parent.company_id !== companyId) {
    throw ApiError.validation('部门参数不合法', { parentId: ['上级部门必须属于同一公司'] })
  }
  if (!parent.enabled) {
    throw ApiError.validation('部门参数不合法', { parentId: ['上级部门已停用'] })
  }
  if (selfPath !== undefined && parent.path.startsWith(selfPath)) {
    throw ApiError.validation('部门参数不合法', { parentId: ['上级部门不能是自身的下级'] })
  }
  return { id: parent.id, path: parent.path }
}

/**
 * 树级串行化：路径重算与父子校验必须互斥。锁按**公司**取（部门树不跨公司，
 * 父子与子树重算都封闭在一家公司内），公司间的部门写入互不阻塞。
 */
async function lockCompanyTree(db: DbHandle, companyId: string): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`sys_department:${companyId}`}::text, 0))
  `.execute(db)
}

/**
 * 取部门所在公司（先于行锁，用于选锁）。公司列是 createOnly、不会变，
 * 无锁读安全；行不存在即 not_found（与授权不命中同一语义，不泄露存在性）。
 */
async function companyOf(db: DbHandle, id: string): Promise<string> {
  const row = await db
    .selectFrom('sys_department')
    .select('company_id')
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) throw new ApiError('not_found', '部门不存在')
  return row.company_id
}

function runeLen(value: string): number {
  return [...value].length
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v))
}
