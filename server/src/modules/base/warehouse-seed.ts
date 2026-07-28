import type { DbHandle } from '~/db/tx.ts'
import { auditCreated, writeAudit } from '~/platform/audit/write.ts'
import type { Actor } from '~/platform/authz/actor.ts'
import { ApiError } from '~/platform/http/errors.ts'

const WAREHOUSE_AUDIT = [
  'name',
  'is_leaf',
  'active',
  'is_outsourced',
  'allow_negative',
  'company_id',
  'parent_id',
  'account_id',
  'party_type',
  'party_id',
] as const

/**
 * 公司新建同事务种子三仓：根「所有仓库」+ 叶「默认仓库」+ 叶「在途」。
 * 幂等：公司下已有仓库则跳过（对齐 server-go warehouse.SeedCompanyDefaults）。
 */
export async function seedCompanyDefaultWarehouses(
  trx: DbHandle,
  actor: Actor,
  companyId: string,
  companyCode: string,
): Promise<number> {
  const existing = await trx
    .selectFrom('inv_warehouse')
    .select('id')
    .where('company_id', '=', companyId)
    .executeTakeFirst()
  if (existing) return 0

  try {
    const root = await trx
      .insertInto('inv_warehouse')
      .values({
        name: `${companyCode} - 所有仓库`,
        is_leaf: false,
        company_id: companyId,
        parent_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    const leaves = await Promise.all(
      [`${companyCode} - 默认仓库`, `${companyCode} - 在途`].map((name) =>
        trx
          .insertInto('inv_warehouse')
          .values({
            name,
            is_leaf: true,
            company_id: companyId,
            parent_id: root.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      ),
    )

    const rows = [root, ...leaves]
    for (const row of rows) {
      await writeAudit(trx, actor, {
        resource: 'inv_warehouse',
        recordId: row.id,
        recordLabel: row.name,
        actionType: 'create',
        actionName: 'create',
        companyId,
        changes: auditCreated(
          {
            name: row.name,
            is_leaf: row.is_leaf,
            active: row.active,
            is_outsourced: row.is_outsourced,
            allow_negative: row.allow_negative,
            company_id: row.company_id,
            parent_id: row.parent_id,
            account_id: row.account_id,
            party_type: row.party_type,
            party_id: row.party_id,
          },
          WAREHOUSE_AUDIT,
        ),
      })
    }
    return rows.length
  } catch (err) {
    throw new ApiError('internal', '创建默认仓库失败', { cause: err })
  }
}
