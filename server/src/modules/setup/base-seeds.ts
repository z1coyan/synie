/**
 * 初始化基础域种子（物料分类等业务表）。
 * platform/setup 向导只编排；业务表写入住在 modules。
 */
import { sql } from 'kysely'
import type { DbHandle } from '~/db/tx.ts'
import { ApiError } from '~/platform/http/errors.ts'

/** 预置物料分类树（幂等：已有任意分类则跳过）。 */
export async function seedMaterialCategories(trx: DbHandle): Promise<void> {
  const exists = await sql<{ e: boolean }>`
    SELECT EXISTS (SELECT 1 FROM inv_material_category) AS e
  `.execute(trx)
  if (exists.rows[0]?.e) return

  const categories: Array<{ code: string; name: string; children: Array<[string, string]> }> = [
    {
      code: 'F',
      name: '产品',
      children: [
        ['F(P)', '客户产品成品'],
        ['F(S)', '半成品'],
        ['F(G)', '通用成品'],
      ],
    },
    {
      code: 'P',
      name: '包材',
      children: [
        ['P(W)', '木箱'],
        ['P(C)', '纸箱'],
        ['P(B)', '袋与填充'],
      ],
    },
    {
      code: 'E',
      name: '设备工量具',
      children: [
        ['E(E)', '设备'],
        ['E(T)', '工量具'],
      ],
    },
    {
      code: 'M',
      name: '劳保耗材',
      children: [
        ['M(L)', '劳保用品'],
        ['M(C)', '耗材'],
      ],
    },
    {
      code: 'S',
      name: '服务',
      children: [['S(G)', '一般服务']],
    },
  ]
  try {
    for (const cat of categories) {
      const parent = await sql<{ id: string }>`
        INSERT INTO inv_material_category (code, name, is_leaf, active)
        VALUES (${cat.code}, ${cat.name}, false, true)
        RETURNING id
      `.execute(trx)
      const parentId = parent.rows[0]!.id
      for (const [code, name] of cat.children) {
        await sql`
          INSERT INTO inv_material_category (code, name, is_leaf, active, parent_id)
          VALUES (${code}, ${name}, true, true, ${parentId}::uuid)
        `.execute(trx)
      }
    }
  } catch (err) {
    throw new ApiError('internal', '预置物料分类失败', { cause: err })
  }
}
