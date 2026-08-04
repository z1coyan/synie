import type { ListQuery } from '@synie/shared'
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import {
  auditCreated,
  auditDestroyed,
  auditDiff,
  writeAudit,
} from '~/platform/audit/write.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import { mapWriteError } from '~/db/dberr.ts'
import { listFromSource } from '~/db/list.ts'
import {requirePermission,  runeLen, toDate } from './helpers.ts'
import { materialCategoryResourceMeta } from './meta.ts'

export interface MaterialCategory {
  id: string
  code: string
  name: string
  isLeaf: boolean
  active: boolean
  insertedAt: Date
  updatedAt: Date
  parentId: string | null
  parent: { id: string; name: string } | null
  hasChildren: boolean
}

const AUDIT = auditFieldsOf(materialCategoryResourceMeta())
const META = materialCategoryResourceMeta()

const SOURCE = sql`
  FROM (
    SELECT c.id,c.code,c.name,c.is_leaf,c.active,c.inserted_at,c.updated_at,c.parent_id,
           p.name AS parent_name,
           EXISTS(SELECT 1 FROM inv_material_category child WHERE child.parent_id=c.id) AS has_children
    FROM inv_material_category c
    LEFT JOIN inv_material_category p ON p.id=c.parent_id
  ) material_category
`

export function createMaterialCategoryService(db: Kysely<Database>) {
  async function get(actor: Actor, id: string): Promise<MaterialCategory> {
    requirePermission(actor, 'base.material_category:read')
    const rows = await sql<Record<string, unknown>>`
      SELECT id,code,name,is_leaf,active,inserted_at,updated_at,parent_id,parent_name,has_children
      ${SOURCE} WHERE id = ${id}::uuid
    `.execute(db)
    if (rows.rows.length === 0) throw new ApiError('not_found', '物料分类不存在')
    return mapRow(rows.rows[0]!)
  }

  async function list(actor: Actor, query: Partial<ListQuery>) {
    requirePermission(actor, 'base.material_category:read')
    return listFromSource({
      db,
      resource: META,
      source: SOURCE,
      select: sql`SELECT id,code,name,is_leaf,active,inserted_at,updated_at,parent_id,parent_name,has_children`,
      defaultOrder: sql`"code" ASC, "id" ASC`,
      query,
      mapRow,
    })
  }

  async function create(
    actor: Actor,
    input: {
      code: string
      name: string
      isLeaf?: boolean
      active?: boolean
      parentId?: string | null
    },
  ): Promise<MaterialCategory> {
    requirePermission(actor, 'base.material_category:create')
    const code = input.code.trim()
    const name = input.name.trim()
    validateNames(code, name)
    const isLeaf = input.isLeaf ?? true
    const active = input.active ?? true
    const parentId = input.parentId ?? null
    return withTx(db, async (trx) => {
      await lockTree(trx)
      await validateParent(trx, null, parentId)
      try {
        const row = await trx
          .insertInto('inv_material_category')
          .values({ code, name, is_leaf: isLeaf, active, parent_id: parentId })
          .returningAll()
          .executeTakeFirstOrThrow()
        const item = await getInTx(trx, row.id)
        await writeAudit(trx, actor, {
          resource: 'inv_material_category',
          recordId: item.id,
          recordLabel: item.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(snap(item), AUDIT),
        })
        return item
      } catch (err) {
        throw mapWriteError(err, '创建物料分类失败', [
          { code: '23505', constraint: 'inv_material_category_unique_code_index', message: '分类编号已存在' },
          { code: '23505', message: '物料分类唯一字段已存在' },
        ])
      }
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: {
      code?: string
      name?: string
      isLeaf?: boolean
      active?: boolean
      parentId?: string | null
      parentIdPresent?: boolean
    },
  ): Promise<MaterialCategory> {
    requirePermission(actor, 'base.material_category:update')
    return withTx(db, async (trx) => {
      await lockTree(trx)
      const locked = await trx
        .selectFrom('inv_material_category')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '物料分类不存在')
      const before = await getInTx(trx, id)
      const code = (input.code ?? before.code).trim()
      const name = (input.name ?? before.name).trim()
      validateNames(code, name)
      const isLeaf = input.isLeaf ?? before.isLeaf
      const active = input.active ?? before.active
      const parentId = input.parentIdPresent ? (input.parentId ?? null) : before.parentId
      await validateParent(trx, id, parentId)
      if (isLeaf !== locked.is_leaf) {
        if (isLeaf) {
          const child = await trx
            .selectFrom('inv_material_category')
            .select('id')
            .where('parent_id', '=', id)
            .executeTakeFirst()
          if (child) {
            throw ApiError.validation('物料分类参数不合法', {
              isLeaf: ['存在下级分类,不能改为叶子分类'],
            })
          }
        } else {
          const mat = await trx
            .selectFrom('inv_material')
            .select('id')
            .where('category_id', '=', id)
            .executeTakeFirst()
          if (mat) {
            throw ApiError.validation('物料分类参数不合法', {
              isLeaf: ['分类下存在物料,不能改为非叶子分类'],
            })
          }
        }
      }
      const after: MaterialCategory = {
        ...before,
        code,
        name,
        isLeaf,
        active,
        parentId,
      }
      const changes = auditDiff(snap(before), snap(after), AUDIT)
      if (Object.keys(changes).length === 0) return before
      try {
        await trx
          .updateTable('inv_material_category')
          .set({
            code,
            name,
            is_leaf: isLeaf,
            active,
            parent_id: parentId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mapWriteError(err, '更新物料分类失败', [
          { code: '23505', constraint: 'inv_material_category_unique_code_index', message: '分类编号已存在' },
          { code: '23505', message: '物料分类唯一字段已存在' },
        ])
      }
      const updated = await getInTx(trx, id)
      await writeAudit(trx, actor, {
        resource: 'inv_material_category',
        recordId: id,
        recordLabel: updated.name,
        actionType: 'update',
        actionName: 'update',
        changes,
      })
      return updated
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'base.material_category:delete')
    await withTx(db, async (trx) => {
      await lockTree(trx)
      const locked = await trx
        .selectFrom('inv_material_category')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '物料分类不存在')
      const child = await trx
        .selectFrom('inv_material_category')
        .select('id')
        .where('parent_id', '=', id)
        .executeTakeFirst()
      if (child) throw new ApiError('conflict', '存在下级分类,不能删除')
      const mat = await trx
        .selectFrom('inv_material')
        .select('id')
        .where('category_id', '=', id)
        .executeTakeFirst()
      if (mat) throw new ApiError('conflict', '分类下存在物料,不能删除')
      const item = await getInTx(trx, id)
      await trx.deleteFrom('inv_material_category').where('id', '=', id).execute()
      await writeAudit(trx, actor, {
        resource: 'inv_material_category',
        recordId: id,
        recordLabel: item.name,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(snap(item), AUDIT),
      })
    })
  }

  return { get, list, create, update, remove }
}

export type MaterialCategoryService = ReturnType<typeof createMaterialCategoryService>

async function getInTx(db: DbHandle, id: string): Promise<MaterialCategory> {
  const rows = await sql<Record<string, unknown>>`
    SELECT id,code,name,is_leaf,active,inserted_at,updated_at,parent_id,parent_name,has_children
    ${SOURCE} WHERE id = ${id}::uuid
  `.execute(db)
  if (rows.rows.length === 0) throw new ApiError('not_found', '物料分类不存在')
  return mapRow(rows.rows[0]!)
}

function mapRow(r: Record<string, unknown>): MaterialCategory {
  const parentId = r.parent_id == null ? null : String(r.parent_id)
  const parentName = r.parent_name == null ? null : String(r.parent_name)
  return {
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    isLeaf: Boolean(r.is_leaf),
    active: Boolean(r.active),
    insertedAt: toDate(r.inserted_at),
    updatedAt: toDate(r.updated_at),
    parentId,
    parent: parentId && parentName ? { id: parentId, name: parentName } : null,
    hasChildren: Boolean(r.has_children),
  }
}

function snap(item: MaterialCategory): Record<string, unknown> {
  return {
    code: item.code,
    name: item.name,
    is_leaf: item.isLeaf,
    active: item.active,
    parent_id: item.parentId,
  }
}

function validateNames(code: string, name: string): void {
  const fields: Record<string, string[]> = {}
  if (!code || runeLen(code) > 32) fields.code = ['不能为空且最多 32 个字符']
  if (!name || runeLen(name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('物料分类参数不合法', fields)
  }
}

async function lockTree(db: DbHandle): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('inv_material_category', 0))`.execute(db)
}

async function validateParent(
  db: DbHandle,
  id: string | null,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return
  if (id && parentId === id) {
    throw ApiError.validation('物料分类参数不合法', { parentId: ['上级分类不能选择自身'] })
  }
  const parent = await db
    .selectFrom('inv_material_category')
    .select(['id', 'is_leaf'])
    .where('id', '=', parentId)
    .executeTakeFirst()
  if (!parent) {
    throw ApiError.validation('物料分类参数不合法', { parentId: ['上级分类不存在'] })
  }
  if (parent.is_leaf) {
    throw ApiError.validation('物料分类参数不合法', {
      parentId: ['上级分类是叶子分类,不能挂子分类'],
    })
  }
}
