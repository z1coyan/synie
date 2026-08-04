/**
 * 模具设计（mfg_mold_design）：生产域独立实体，1:1 挂物料。
 * 创建时同事务自动建资产类物料（material_type='ASSET'，分类取生产设置「模具物料分类」，
 * 编号走 inv.material 既有规则）；编辑同步物料名称/规格/单位；删除级联删物料。
 */
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
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { listFromSource } from '~/db/list.ts'
import { requirePermission, mfgWriteError, runeCount, trimOptional } from './helpers.ts'
import { moldDesignResourceMeta } from './meta.ts'
import type { ListQueryInput } from './types.ts'

export const MOLD_TYPES = ['STAMPING', 'FORMING', 'POSITIONING', 'OTHER'] as const
export type MoldType = (typeof MOLD_TYPES)[number]

export interface MoldDesign {
  id: string
  moldType: string
  materialId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitId: string
  unitName: string
  categoryId: string
  insertedAt: Date
  updatedAt: Date
}

const MOLD_AUDIT = ['mold_type', 'material_id'] as const
const MATERIAL_AUDIT = ['code', 'material_type', 'name', 'spec', 'category_id', 'default_unit_id'] as const

const META = moldDesignResourceMeta()

const SOURCE = sql`
  FROM (
    SELECT d.id,d.mold_type,d.material_id,d.inserted_at,d.updated_at,
           m.code AS material_code,m.name AS material_name,m.spec AS material_spec,
           m.default_unit_id AS unit_id,m.category_id,
           u.name AS unit_name
    FROM mfg_mold_design d
    JOIN inv_material m ON m.id=d.material_id
    JOIN bas_unit u ON u.id=m.default_unit_id
  ) mold_design
`

export function createMoldDesignService(db: Kysely<Database>, numbering: NumberingService) {
  async function create(
    actor: Actor,
    input: { name: string; spec?: string | null; moldType: string; unitId: string },
  ): Promise<MoldDesign> {
    requirePermission(actor, 'mfg.mold_design:create')
    const normalized = normalize(input)
    return withTx(db, async (trx) => {
      // 模具物料分类：生产设置单行配置，受信任读（不检 mfg.setting 权限）
      const setting = await trx
        .selectFrom('mfg_setting')
        .select('mold_category_id')
        .executeTakeFirst()
      const categoryId = setting?.mold_category_id ?? null
      if (!categoryId) {
        throw new ApiError('conflict', '请先在生产设置中配置模具物料分类')
      }
      const cat = await trx
        .selectFrom('inv_material_category')
        .select(['is_leaf', 'active'])
        .where('id', '=', categoryId)
        .executeTakeFirst()
      if (!cat || !cat.is_leaf || !cat.active) {
        throw new ApiError('conflict', '生产设置的模具物料分类不是启用的叶子分类,请重新配置')
      }
      const unit = await trx
        .selectFrom('bas_unit')
        .select('id')
        .where('id', '=', normalized.unitId)
        .executeTakeFirst()
      if (!unit) {
        throw ApiError.validation('模具参数不合法', { unitId: ['单位不存在'] })
      }
      const code = (
        await numbering.nextInTx(trx, {
          resource: 'inv.material',
          values: {
            name: normalized.name,
            spec: normalized.spec,
            customer_part_no: null,
            is_customer_material: false,
            active: true,
            category_id: categoryId,
            default_unit_id: normalized.unitId,
            customer_id: null,
          },
        })
      ).trim()
      if (!code || runeCount(code) > 64) {
        throw ApiError.validation('模具参数不合法', {
          code: ['自动编号不能为空且最多 64 个字符'],
        })
      }
      try {
        const material = await trx
          .insertInto('inv_material')
          .values({
            code,
            material_type: 'ASSET',
            name: normalized.name,
            spec: normalized.spec,
            customer_part_no: null,
            is_customer_material: false,
            active: true,
            category_id: categoryId,
            default_unit_id: normalized.unitId,
            customer_id: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        const design = await trx
          .insertInto('mfg_mold_design')
          .values({ mold_type: normalized.moldType, material_id: material.id })
          .returningAll()
          .executeTakeFirstOrThrow()
        await writeAudit(trx, actor, {
          resource: 'inv_material',
          recordId: material.id,
          recordLabel: material.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(
            {
              code: material.code,
              material_type: material.material_type,
              name: material.name,
              spec: material.spec,
              category_id: material.category_id,
              default_unit_id: material.default_unit_id,
            },
            MATERIAL_AUDIT,
          ),
        })
        await writeAudit(trx, actor, {
          resource: 'mfg_mold_design',
          recordId: design.id,
          recordLabel: material.name,
          actionType: 'create',
          actionName: 'create',
          changes: auditCreated(
            { mold_type: design.mold_type, material_id: design.material_id },
            MOLD_AUDIT,
          ),
        })
        return await getInTx(trx, design.id)
      } catch (err) {
        throw mfgWriteError('创建模具设计失败', err, [
          { code: '23505', constraint: 'inv_material_unique_code_index', message: '物料编号已存在' },
          { code: '23505', constraint: 'mfg_mold_design_material_unique', message: '该物料已挂模具设计' },
        ])
      }
    })
  }

  async function get(actor: Actor, id: string): Promise<MoldDesign> {
    requirePermission(actor, 'mfg.mold_design:read')
    return getInTx(db, id)
  }

  async function list(actor: Actor, query: ListQueryInput) {
    requirePermission(actor, 'mfg.mold_design:read')
    return listFromSource({
      db,
      resource: META,
      source: SOURCE,
      select: sql`SELECT *`,
      defaultOrder: sql`"material_code" ASC, "id" ASC`,
      query,
      mapRow,
    })
  }

  async function update(
    actor: Actor,
    id: string,
    input: {
      name?: string
      spec?: string | null
      specPresent?: boolean
      moldType?: string
      unitId?: string
    },
  ): Promise<MoldDesign> {
    requirePermission(actor, 'mfg.mold_design:update')
    return withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('mfg_mold_design')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '模具设计不存在')
      const before = await getInTx(trx, id)
      const normalized = normalize({
        name: input.name ?? before.materialName,
        spec: input.specPresent ? (input.spec ?? null) : before.materialSpec,
        moldType: input.moldType ?? before.moldType,
        unitId: input.unitId ?? before.unitId,
      })
      // 单位变更走物料保护先例：存在单位转换行时不可改
      if (normalized.unitId !== before.unitId) {
        const conv = await trx
          .selectFrom('inv_material_unit')
          .select('id')
          .where('material_id', '=', before.materialId)
          .executeTakeFirst()
        if (conv) {
          throw ApiError.validation('模具参数不合法', {
            unitId: ['存在单位转换行,不能修改单位,请先在物料管理中删除转换行'],
          })
        }
        const unit = await trx
          .selectFrom('bas_unit')
          .select('id')
          .where('id', '=', normalized.unitId)
          .executeTakeFirst()
        if (!unit) {
          throw ApiError.validation('模具参数不合法', { unitId: ['单位不存在'] })
        }
      }
      try {
        await trx
          .updateTable('inv_material')
          .set({
            name: normalized.name,
            spec: normalized.spec,
            default_unit_id: normalized.unitId,
            updated_at: sql`(now() AT TIME ZONE 'utc')`,
          })
          .where('id', '=', before.materialId)
          .execute()
        await trx
          .updateTable('mfg_mold_design')
          .set({ mold_type: normalized.moldType, updated_at: sql`(now() AT TIME ZONE 'utc')` })
          .where('id', '=', id)
          .execute()
      } catch (err) {
        throw mfgWriteError('更新模具设计失败', err)
      }
      const after = await getInTx(trx, id)
      const designChanges = auditDiff(
        { mold_type: before.moldType, material_id: before.materialId },
        { mold_type: after.moldType, material_id: after.materialId },
        MOLD_AUDIT,
      )
      if (Object.keys(designChanges).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'mfg_mold_design',
          recordId: id,
          recordLabel: after.materialName,
          actionType: 'update',
          actionName: 'update',
          changes: designChanges,
        })
      }
      const materialChanges = auditDiff(
        {
          code: before.materialCode,
          material_type: 'ASSET',
          name: before.materialName,
          spec: before.materialSpec,
          category_id: before.categoryId,
          default_unit_id: before.unitId,
        },
        {
          code: after.materialCode,
          material_type: 'ASSET',
          name: after.materialName,
          spec: after.materialSpec,
          category_id: after.categoryId,
          default_unit_id: after.unitId,
        },
        MATERIAL_AUDIT,
      )
      if (Object.keys(materialChanges).length > 0) {
        await writeAudit(trx, actor, {
          resource: 'inv_material',
          recordId: after.materialId,
          recordLabel: after.materialName,
          actionType: 'update',
          actionName: 'update',
          changes: materialChanges,
        })
      }
      return after
    })
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    requirePermission(actor, 'mfg.mold_design:delete')
    await withTx(db, async (trx) => {
      const locked = await trx
        .selectFrom('mfg_mold_design')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst()
      if (!locked) throw new ApiError('not_found', '模具设计不存在')
      const item = await getInTx(trx, id)
      const stock = await trx
        .selectFrom('inv_stock_entry')
        .select('id')
        .where('material_id', '=', item.materialId)
        .executeTakeFirst()
      if (stock) throw new ApiError('conflict', '模具物料已被库存分录引用,不能删除')
      try {
        await trx.deleteFrom('mfg_mold_design').where('id', '=', id).execute()
        await trx
          .deleteFrom('inv_material_unit')
          .where('material_id', '=', item.materialId)
          .execute()
        await trx.deleteFrom('inv_material').where('id', '=', item.materialId).execute()
      } catch (err) {
        throw mfgWriteError('删除模具设计失败', err, [
          { code: '23503', message: '模具物料已被业务引用,不能删除' },
        ])
      }
      await writeAudit(trx, actor, {
        resource: 'mfg_mold_design',
        recordId: id,
        recordLabel: item.materialName,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(
          { mold_type: item.moldType, material_id: item.materialId },
          MOLD_AUDIT,
        ),
      })
      await writeAudit(trx, actor, {
        resource: 'inv_material',
        recordId: item.materialId,
        recordLabel: item.materialName,
        actionType: 'destroy',
        actionName: 'destroy',
        changes: auditDestroyed(
          {
            code: item.materialCode,
            material_type: 'ASSET',
            name: item.materialName,
            spec: item.materialSpec,
            category_id: item.categoryId,
            default_unit_id: item.unitId,
          },
          MATERIAL_AUDIT,
        ),
      })
    })
  }

  return { create, get, list, update, remove }
}

export type MoldDesignService = ReturnType<typeof createMoldDesignService>

async function getInTx(db: DbHandle, id: string): Promise<MoldDesign> {
  const rows = await sql<Record<string, unknown>>`SELECT * ${SOURCE} WHERE id = ${id}::uuid`.execute(db)
  if (rows.rows.length === 0) throw new ApiError('not_found', '模具设计不存在')
  return mapRow(rows.rows[0]!)
}

function mapRow(r: Record<string, unknown>): MoldDesign {
  return {
    id: String(r.id),
    moldType: String(r.mold_type),
    materialId: String(r.material_id),
    materialCode: String(r.material_code),
    materialName: String(r.material_name),
    materialSpec: r.material_spec == null ? null : String(r.material_spec),
    unitId: String(r.unit_id),
    unitName: String(r.unit_name),
    categoryId: String(r.category_id),
    insertedAt: r.inserted_at instanceof Date ? r.inserted_at : new Date(String(r.inserted_at)),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(String(r.updated_at)),
  }
}

function normalize(input: {
  name: string
  spec?: string | null
  moldType: string
  unitId: string
}): { name: string; spec: string | null; moldType: MoldType; unitId: string } {
  const result = {
    name: input.name.trim(),
    spec: trimOptional(input.spec),
    moldType: input.moldType.trim().toUpperCase() as MoldType,
    unitId: input.unitId,
  }
  const fields: Record<string, string[]> = {}
  if (!result.name || runeCount(result.name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (result.spec && runeCount(result.spec) > 128) fields.spec = ['最多 128 个字符']
  if (!(MOLD_TYPES as readonly string[]).includes(result.moldType)) {
    fields.moldType = ['只能为 STAMPING(冲压)/FORMING(变形)/POSITIONING(定位)/OTHER(其他)']
  }
  if (!result.unitId) fields.unitId = ['不能为空']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('模具参数不合法', fields)
  }
  return result
}
