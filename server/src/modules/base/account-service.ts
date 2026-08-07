/**
 * 会计科目（公司域主数据）——标准派生服务 + 树能力，模板初始化按动作弹射保留手写。
 *
 * CRUD/授权/审计/批量与树不变量（父子同公司、成环、有子科目不可删）由 platform/standard
 * 按 meta 派生；本文件只声明领域不变量与一处联动：
 * 汇总科目清空角色（validate 行内充实）、公司/币种引用与外币不得挂角色（beforeWrite）。
 *
 * 上级/公司/币种的嵌套 wire 形状与 hasChildren 由 projection 承接（列表与单条共用一份
 * 投影 SQL，写后事务内按投影重载）。树锁按公司取——科目树不跨公司。
 *
 * `initializeTemplate` 是三套模板的整树批量建账（非标准词表动作），保留手写；
 * 与内核 CRUD 的互斥靠同一把 advisory 树锁（键 `bas_account:<公司>`）。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import { mapWriteError } from '~/db/dberr.ts'
import { assertCompanyWritable } from '~/db/load.ts'
import { withTx, type DbHandle } from '~/db/tx.ts'
import type { DB as Database } from '~/db/types.ts'
import { auditFieldsOf } from '~/platform/audit/spec.ts'
import { auditCreated, writeAudit } from '~/platform/audit/write.ts'
import type { Permit } from '~/platform/authz/core/index.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { mapRow, snapshot } from '~/platform/standard/fields.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { ACCOUNT_RESOURCE_NAME, accountResourceMeta } from './meta.ts'
import templateData from './templates.json'

export interface Reference {
  id: string
  name: string
}

export interface Account {
  id: string
  code: string
  name: string
  direction: 'DEBIT' | 'CREDIT'
  isGroup: boolean
  active: boolean
  role: string | null
  parentId: string | null
  companyId: string
  currencyId: string | null
  parent: Reference | null
  company: Reference
  currency: Reference | null
  hasChildren: boolean
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
}

export interface TemplateResult {
  createdCount: number
}

const META = accountResourceMeta()
const AUDIT = auditFieldsOf(META)
const TABLE = META.table

const ACCOUNT_SOURCE = sql`
 FROM (
	SELECT a.id, a.code, a.name, a.direction, a.is_group, a.active, a.role,
	       a.parent_id, a.company_id, a.currency_id, a.inserted_at, a.updated_at,
	       p.name AS parent_name, c.name AS company_name, currency.name AS currency_name,
	       EXISTS(SELECT 1 FROM bas_account child WHERE child.parent_id = a.id) AS has_children
	FROM bas_account a
	LEFT JOIN bas_account p ON p.id = a.parent_id
	JOIN bas_company c ON c.id = a.company_id
	LEFT JOIN bas_currency currency ON currency.id = a.currency_id
) account`
/** 投影别名必须与 ACCOUNT_SOURCE 的 `) account` 逐字一致 */
const ACCOUNT_ALIAS = 'account'
const ACCOUNT_SELECT_EXTRA = sql`parent_name, company_name, currency_name, has_children`

type TemplateEntry = {
  code: string
  name: string
  direction: string
  is_group: boolean
  parent: string | null
  role: string | null
}

const templates = templateData as Record<string, TemplateEntry[]>

export interface AccountService extends StandardService<Account> {
  /** 三套默认科目表整树建账（公司下无科目才可执行） */
  initializeTemplate(permit: Permit, companyId: string, template: string): Promise<TemplateResult>
}

/**
 * 汇总科目不挂标准科目角色（行内充实，非报错）：与旧 normalizeCreate 同语义，
 * create/update 都生效（update 的 draft 已并入现值，故沿用现有 isGroup 亦成立）。
 */
export function applyGroupRoleRule(draft: Record<string, unknown>): void {
  if (draft.isGroup === true) draft.role = null
}

export function createAccountService(db: Kysely<Database>, registry: Registry): AccountService {
  const standard = createStandardService<Account>({
    db,
    registry,
    resource: ACCOUNT_RESOURCE_NAME,
    notFound: '会计科目不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: '同一公司内科目编码不能重复' },
      { code: '23503', message: '会计科目已被引用，不能删除' },
    ],
    projection: {
      source: ACCOUNT_SOURCE,
      alias: ACCOUNT_ALIAS,
      selectExtra: ACCOUNT_SELECT_EXTRA,
      mapExtra: (row) => ({
        parent:
          row.parent_id && row.parent_name
            ? { id: String(row.parent_id), name: String(row.parent_name) }
            : null,
        company: { id: String(row.company_id), name: String(row.company_name) },
        currency:
          row.currency_id && row.currency_name
            ? { id: String(row.currency_id), name: String(row.currency_name) }
            : null,
        hasChildren: Boolean(row.has_children),
      }),
    },
    tree: { childBlockMessage: '存在子科目，不能删除' },
    hooks: {
      validate: ({ draft }) => applyGroupRoleRule(draft),
      beforeWrite: async (trx, { draft }) => {
        await validateRelations(trx, draft)
      },
    },
  })

  async function initializeTemplate(
    permit: Permit,
    companyId: string,
    template: string,
  ): Promise<TemplateResult> {
    const key = template.trim().toLowerCase()
    const entries = templates[key]
    if (!entries) {
      throw ApiError.validation('会计科目模板参数不合法', {
        template: ['仅支持 CAS/SMALL/INTL'],
      })
    }
    assertCompanyWritable(permit, companyId, '公司不存在')
    return withTx(db, async (trx) => {
      await lockAccountTree(trx, companyId)
      const company = await trx
        .selectFrom('bas_company')
        .select('id')
        .where('id', '=', companyId)
        .executeTakeFirst()
      if (!company) {
        throw ApiError.validation('会计科目模板参数不合法', {
          companyId: ['公司不存在'],
        })
      }
      const existing = await trx
        .selectFrom('bas_account')
        .select(trx.fn.countAll<string>().as('count'))
        .where('company_id', '=', companyId)
        .executeTakeFirstOrThrow()
      if (Number(existing.count) !== 0) {
        throw new ApiError('conflict', '该公司已有会计科目，不能重复初始化')
      }

      const parentIds = new Map<string, string>()
      for (const entry of entries) {
        let parentId: string | null = null
        if (entry.parent) {
          const pid = parentIds.get(entry.parent)
          if (!pid) throw new ApiError('internal', '会计科目模板父子顺序不合法')
          parentId = pid
        }
        const role = entry.role ? entry.role.toLowerCase() : null
        try {
          const inserted = await trx
            .insertInto('bas_account')
            .values({
              code: entry.code,
              name: entry.name,
              direction: entry.direction.toLowerCase(),
              is_group: entry.is_group,
              active: true,
              role,
              parent_id: parentId,
              company_id: companyId,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
          parentIds.set(inserted.code, inserted.id)
          const item = mapRow(META, inserted as unknown as Record<string, unknown>)
          await writeAudit(trx, permit.actor, {
            resource: TABLE,
            recordId: String(item.id),
            recordLabel: String(item.name),
            companyId,
            actionType: 'create',
            actionName: 'init_from_template',
            changes: auditCreated(snapshot(META, item, AUDIT), AUDIT),
          })
        } catch (err) {
          if (err instanceof ApiError) throw err
          throw mapWriteError(err, '初始化会计科目失败', [
            { code: '23505', message: '同一公司内科目编码不能重复' },
          ])
        }
      }
      return { createdCount: entries.length }
    })
  }

  return { ...standard, initializeTemplate }
}

/** 与内核树锁同键（`表名:公司`）：模板建账与 CRUD 必须互斥 */
async function lockAccountTree(trx: DbHandle, companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${TABLE}:${companyId}`}::text, 0))`.execute(trx)
}

/**
 * 引用不变量：公司存在、币种存在、外币科目不得设标准角色。
 * 上级科目的存在性/同公司/成环由内核树能力判定（tree 声明）。
 */
async function validateRelations(trx: DbHandle, draft: Record<string, unknown>): Promise<void> {
  const company = await trx
    .selectFrom('bas_company')
    .select('id')
    .where('id', '=', String(draft.companyId))
    .executeTakeFirst()
  if (!company) {
    throw ApiError.validation('会计科目参数不合法', { companyId: ['公司不存在'] })
  }
  const currencyId = draft.currencyId
  if (typeof currencyId === 'string' && currencyId) {
    const currency = await trx
      .selectFrom('bas_currency')
      .select(['id', 'iso_code'])
      .where('id', '=', currencyId)
      .executeTakeFirst()
    if (!currency) {
      throw ApiError.validation('会计科目参数不合法', { currencyId: ['币种不存在'] })
    }
    if (draft.role && currency.iso_code.toUpperCase() !== 'CNY') {
      throw ApiError.validation('会计科目参数不合法', {
        role: ['外币科目不能设置标准科目角色'],
      })
    }
  }
}
