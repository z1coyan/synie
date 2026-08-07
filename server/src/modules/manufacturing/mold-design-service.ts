/**
 * 模具设计（mfg_mold_design）：生产域独立实体，1:1 挂物料（两表都无公司列 → global）。
 * 创建时同事务自动建资产类物料（material_type='ASSET'，分类取生产设置「模具物料分类」，
 * 编号走 base.material 既有规则）；编辑同步物料名称/规格/单位；删除级联删物料。
 *
 * 授权全由平台承担：路由挂 `guard(资源, 动作)`，本服务只收 Permit。
 * 跨资源写（每次写模具必然连带写物料）用路由的 `allOf` 声明式门控——
 * 模具动作码 ∧ 物料同名动作码，凭证范围取格上最小；物料行本身再走
 * `loadAuthorized(invMaterials, forUpdate)`（既是授权也是 1:1 伴生行的行锁）。
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
import { auditFieldsOf, pickAuditFields } from '~/platform/audit/spec.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { listAuthorized } from '~/db/list.ts'
import { loadAuthorized, loadAuthorizedFrom } from '~/db/load.ts'
import { MATERIAL_RESOURCE } from '~/modules/inventory/material-service.ts'
import { materialResourceMeta } from '~/modules/inventory/meta.ts'
import { runeLen } from '~/platform/posting/text.ts'
import { mfgWriteError, trimOptional } from './helpers.ts'
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

const META = moldDesignResourceMeta()

export const MOLD_DESIGN_RESOURCE = 'mfgMoldDesigns'

const MOLD_TABLE = META.table
const MATERIAL_TABLE = materialResourceMeta().table
/** 列表与单条共用同一份投影（别名与 listAuthorized 的 alias 必须逐字一致） */
const ALIAS = 'mold_design'
const SELECT = sql`SELECT *`

const MOLD_AUDIT = auditFieldsOf(META)
/** 模具服务写物料的动作级局部审计面（客户物料/启用等列模具流程不触碰） */
const MATERIAL_AUDIT = pickAuditFields(auditFieldsOf(materialResourceMeta()), [
  'code',
  'material_type',
  'name',
  'spec',
  'category_id',
  'default_unit_id',
])

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

export function createMoldDesignService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
) {
  const target = registry.authzTarget(MOLD_DESIGN_RESOURCE)
  const materialTarget = registry.authzTarget(MATERIAL_RESOURCE)

  /** 1:1 伴生物料行：授权取行 + 行锁（模具行已先行取过，加锁顺序恒为模具先行） */
  const lockMaterial = (trx: DbHandle, permit: Permit, materialId: string) =>
    loadAuthorized({
      db: trx,
      permit,
      target: materialTarget,
      table: MATERIAL_TABLE,
      id: materialId,
      forUpdate: true,
      notFoundMessage: '模具物料不存在',
    })

  async function create(
    permit: Permit,
    input: { name: string; spec?: string | null; moldType: string; unitId: string },
  ): Promise<MoldDesign> {
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
          resource: 'base.material',
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
      if (!code || runeLen(code) > 64) {
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
        await writeAudit(trx, permit.actor, {
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
        await writeAudit(trx, permit.actor, {
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

  async function get(permit: Permit, id: string): Promise<MoldDesign> {
    return loadAuthorizedFrom({
      db,
      permit,
      target,
      alias: ALIAS,
      source: SOURCE,
      select: SELECT,
      id,
      mapRow,
      notFoundMessage: '模具设计不存在',
    })
  }

  async function list(permit: Permit, query: ListQueryInput) {
    return listAuthorized({
      db,
      permit,
      target,
      alias: ALIAS,
      resource: META,
      source: SOURCE,
      select: SELECT,
      defaultOrder: sql`"material_code" ASC, "id" ASC`,
      query,
      mapRow,
    })
  }

  async function update(
    permit: Permit,
    id: string,
    input: {
      name?: string
      spec?: string | null
      specPresent?: boolean
      moldType?: string
      unitId?: string
    },
  ): Promise<MoldDesign> {
    return withTx(db, async (trx) => {
      await loadAuthorized({
        db: trx,
        permit,
        target,
        table: MOLD_TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '模具设计不存在',
      })
      const before = await getInTx(trx, id)
      await lockMaterial(trx, permit, before.materialId)
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
        await writeAudit(trx, permit.actor, {
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
        await writeAudit(trx, permit.actor, {
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

  async function remove(permit: Permit, id: string): Promise<void> {
    await withTx(db, async (trx) => {
      await loadAuthorized({
        db: trx,
        permit,
        target,
        table: MOLD_TABLE,
        id,
        forUpdate: true,
        notFoundMessage: '模具设计不存在',
      })
      const item = await getInTx(trx, id)
      await lockMaterial(trx, permit, item.materialId)
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
      await writeAudit(trx, permit.actor, {
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
      await writeAudit(trx, permit.actor, {
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
  const rows = await sql<Record<string, unknown>>`${SELECT}${SOURCE} WHERE id = ${id}::uuid`.execute(db)
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
  if (!result.name || runeLen(result.name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (result.spec && runeLen(result.spec) > 128) fields.spec = ['最多 128 个字符']
  if (!(MOLD_TYPES as readonly string[]).includes(result.moldType)) {
    fields.moldType = ['只能为 STAMPING(冲压)/FORMING(变形)/POSITIONING(定位)/OTHER(其他)']
  }
  if (!result.unitId) fields.unitId = ['不能为空']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('模具参数不合法', fields)
  }
  return result
}
