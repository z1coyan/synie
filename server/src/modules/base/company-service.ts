/**
 * 公司（记账主体本身，无公司列 → global 形态）——标准派生服务 + 树能力。
 *
 * CRUD/授权/审计/批量与树不变量（父子校验、成环、有下级不可删）由 platform/standard
 * 按 meta 派生；本文件只声明领域不变量与同事务联动：
 * 两位英文编号、本币须启用（beforeWrite）、删除前清多态从属地址（beforeDelete）、
 * 创建后同事务种子三仓（afterWrite 调既有 seedCompanyDefaultWarehouses）。
 *
 * 上级公司/本币的嵌套 wire 形状（parent / baseCurrency）由 projection 承接：
 * 列表与单条共用一份投影 SQL，写后在事务内按投影重载。
 * 全局树（无公司列）故树锁按整表取；无物化路径列，成环由递归 CTE 判定。
 */
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import type { NumberingService } from '~/platform/numbering/service.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { COMPANY_RESOURCE_NAME } from './meta.ts'
import { seedCompanyDefaultWarehouses } from './warehouse-seed.ts'

export interface Reference {
  id: string
  name: string
}

export interface Company {
  id: string
  code: string
  name: string
  shortName: string
  parentId: string | null
  baseCurrencyId: string
  parent: Reference | null
  baseCurrency: Reference
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
}

const CODE_RE = /^[A-Za-z]{2}$/

const COMPANY_SOURCE = sql`
 FROM (
SELECT c.id, c.code, c.name, c.short_name, c.parent_id, c.base_currency_id,
       c.inserted_at, c.updated_at, p.name AS parent_name, currency.name AS base_currency_name
FROM bas_company AS c
LEFT JOIN bas_company AS p ON p.id = c.parent_id
JOIN bas_currency AS currency ON currency.id = c.base_currency_id
) AS company`
/** 投影别名必须与 COMPANY_SOURCE 的 `AS company` 逐字一致 */
const COMPANY_ALIAS = 'company'
/**
 * 附加列：时间戳未进 meta 字段（历史形状，公司 Grid 不含时间列），
 * 故经投影补出 wire 的 insertedAt/updatedAt。
 */
const COMPANY_SELECT_EXTRA = sql`inserted_at, updated_at, parent_name, base_currency_name`

export function createCompanyService(
  db: Kysely<Database>,
  numbering: NumberingService,
  registry: Registry,
): StandardService<Company> {
  return createStandardService<Company>({
    db,
    registry,
    resource: COMPANY_RESOURCE_NAME,
    notFound: '公司不存在',
    defaultOrder: sql`"code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: '公司编号已存在' },
      { code: '23503', message: '公司已被业务数据引用,不可删除' },
    ],
    projection: {
      source: COMPANY_SOURCE,
      alias: COMPANY_ALIAS,
      selectExtra: COMPANY_SELECT_EXTRA,
      mapExtra: (row) => ({
        insertedAt: toDate(row.inserted_at),
        updatedAt: toDate(row.updated_at),
        parent:
          row.parent_id && row.parent_name
            ? { id: String(row.parent_id), name: String(row.parent_name) }
            : null,
        baseCurrency: { id: String(row.base_currency_id), name: String(row.base_currency_name) },
      }),
    },
    tree: {
      // 下级公司即 parent_id 外键引用：既有文案与 FK 冲突路径逐字一致
      childBlockMessage: '公司已被业务数据引用,不可删除',
    },
    hooks: {
      validate: ({ action, draft }) => {
        // 编号 createOnly，只在创建时校验格式（长度/必填由 meta 派生 schema 挡）
        if (action === 'create' && !CODE_RE.test(String(draft.code ?? ''))) {
          throw ApiError.validation('公司参数不合法', { code: ['必须是恰好两位英文字母'] })
        }
      },
      beforeWrite: async (trx, { draft }) => {
        const currency = await trx
          .selectFrom('bas_currency')
          .select('id')
          .where('id', '=', String(draft.baseCurrencyId))
          .where('active', '=', true)
          .executeTakeFirst()
        if (!currency) {
          throw ApiError.validation('公司参数不合法', {
            baseCurrencyId: ['币种不存在或未启用'],
          })
        }
      },
      afterWrite: async (trx, { action, permit, item }) => {
        if (action !== 'create') return
        await seedCompanyDefaultWarehouses(trx, numbering, permit.actor, String(item.id), String(item.code))
      },
      beforeDelete: async (trx, { item }) => {
        // 公司作为内部公司主体时的从属地址（多态无 FK；库内小写）
        await trx
          .deleteFrom('bas_party_address')
          .where('party_type', '=', 'company')
          .where('party_id', '=', String(item.id))
          .execute()
      },
    },
  })
}

export type CompanyService = StandardService<Company>

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}
