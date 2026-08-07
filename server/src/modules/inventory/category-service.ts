/**
 * 物料分类（全局共享树，无公司列）——标准派生服务。
 *
 * CRUD/批量/审计/授权由 `platform/standard` 按 meta 派生；树写侧不变量由内核 tree 承担
 * （整表 advisory 锁、父子校验与递归 CTE 防环、有下级不可删）；无物化路径列，故不声明
 * pathColumn。列表与单条的父名/含下级投影由内核 projection 复刻（写后同事务重载）。
 *
 * 本文件只留领域不变量（钩子）：
 * - 上级不能是叶子分类（tree.onParent）
 * - 叶子标记翻转的双向保护（有下级不可改叶子；下挂物料不可改非叶子）
 * - 删除前的物料引用保护
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { runeLen } from './helpers.ts'

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
  [key: string]: unknown
}

export const CATEGORY_RESOURCE = 'invMaterialCategories'

/** 列表与单条共用同一份投影（别名与 listAuthorized 的 alias 必须逐字一致） */
const ALIAS = 'material_category'
const SOURCE = sql`
  FROM (
    SELECT c.id,c.code,c.name,c.is_leaf,c.active,c.inserted_at,c.updated_at,c.parent_id,
           p.name AS parent_name,
           EXISTS(SELECT 1 FROM inv_material_category child WHERE child.parent_id=c.id) AS has_children
    FROM inv_material_category c
    LEFT JOIN inv_material_category p ON p.id=c.parent_id
  ) material_category
`
const SELECT_EXTRA = sql`parent_name,has_children`

export function createMaterialCategoryService(
  db: Kysely<Database>,
  registry: Registry,
): StandardService<MaterialCategory> {
  return createStandardService<MaterialCategory>({
    db,
    registry,
    resource: CATEGORY_RESOURCE,
    notFound: '物料分类不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    projection: { source: SOURCE, alias: ALIAS, selectExtra: SELECT_EXTRA, mapExtra },
    writeErrors: [
      {
        code: '23505',
        constraint: 'inv_material_category_unique_code_index',
        message: '分类编号已存在',
      },
      { code: '23505', message: '物料分类唯一字段已存在' },
    ],
    tree: {
      childBlockMessage: '存在下级分类,不能删除',
      // 自身/不存在/成环由内核判；叶子父不可挂子分类是本资源的个性约束
      onParent: (_trx, { parent }) => {
        if (parent.isLeaf) {
          throw ApiError.validation('物料分类参数不合法', {
            parentId: ['上级分类是叶子分类,不能挂子分类'],
          })
        }
      },
    },
    hooks: {
      validate: ({ draft }) => normalizeCategory(draft),
      beforeWrite: async (trx, { action, draft, before }) => {
        if (action !== 'update' || !before) return
        if (draft.isLeaf === before.isLeaf) return
        const id = String(draft.id)
        if (draft.isLeaf) {
          if (await hasChild(trx, id)) {
            throw ApiError.validation('物料分类参数不合法', {
              isLeaf: ['存在下级分类,不能改为叶子分类'],
            })
          }
        } else if (await hasMaterial(trx, id)) {
          throw ApiError.validation('物料分类参数不合法', {
            isLeaf: ['分类下存在物料,不能改为非叶子分类'],
          })
        }
      },
      beforeDelete: async (trx, { item }) => {
        if (await hasMaterial(trx, String(item.id))) {
          throw new ApiError('conflict', '分类下存在物料,不能删除')
        }
      },
    },
  })
}

export type MaterialCategoryService = ReturnType<typeof createMaterialCategoryService>

/** 投影附加列 → wire 嵌套引用对象（上级分类 + 含下级标记） */
function mapExtra(r: Record<string, unknown>): Record<string, unknown> {
  const parentId = r.parent_id == null ? null : String(r.parent_id)
  const parentName = r.parent_name == null ? null : String(r.parent_name)
  return {
    parent: parentId && parentName ? { id: parentId, name: parentName } : null,
    hasChildren: Boolean(r.has_children),
  }
}

/**
 * 领域规范化 + 不变量（原地改 draft）。
 * wire schema 已做 trim/长度校验；此处补服务直调路径（种子数据等）的同等约束。
 */
function normalizeCategory(draft: Record<string, unknown>): void {
  const fields: Record<string, string[]> = {}
  const code = typeof draft.code === 'string' ? draft.code.trim() : ''
  const name = typeof draft.name === 'string' ? draft.name.trim() : ''
  draft.code = code
  draft.name = name
  if (!code || runeLen(code) > 32) fields.code = ['不能为空且最多 32 个字符']
  if (!name || runeLen(name) > 128) fields.name = ['不能为空且最多 128 个字符']
  if (Object.keys(fields).length > 0) {
    throw ApiError.validation('物料分类参数不合法', fields)
  }
}

async function hasChild(db: DbHandle, id: string): Promise<boolean> {
  const row = await db
    .selectFrom('inv_material_category')
    .select('id')
    .where('parent_id', '=', id)
    .executeTakeFirst()
  return Boolean(row)
}

async function hasMaterial(db: DbHandle, categoryId: string): Promise<boolean> {
  const row = await db
    .selectFrom('inv_material')
    .select('id')
    .where('category_id', '=', categoryId)
    .executeTakeFirst()
  return Boolean(row)
}
