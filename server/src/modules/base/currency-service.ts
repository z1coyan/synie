/**
 * 币种（全局主数据，无公司列）——标准派生服务。
 *
 * CRUD/批量/审计/授权全部由 platform/standard 按 meta 派生；
 * 本文件只声明领域不变量：ISO 4217 编码格式（createOnly 字段，只在创建时校验）
 * 与本币引用保护（停用前查公司引用，需查库故走 beforeWrite）。
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { CURRENCY_RESOURCE_NAME } from './meta.ts'

export interface Currency {
  id: string
  name: string
  isoCode: string
  symbol: string | null
  active: boolean
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
}

const ISO_RE = /^[A-Z]{3}$/

export function createCurrencyService(db: Kysely<Database>, registry: Registry): StandardService<Currency> {
  return createStandardService<Currency>({
    db,
    registry,
    resource: CURRENCY_RESOURCE_NAME,
    notFound: '货币不存在',
    defaultOrder: sql`"iso_code" ASC, "id" ASC`,
    writeErrors: [
      { code: '23505', message: 'ISO 编码已存在' },
      { code: '23503', message: '货币已被业务数据引用,不可删除' },
    ],
    hooks: {
      validate: ({ action, draft }) => {
        if (action === 'create' && !ISO_RE.test(String(draft.isoCode ?? ''))) {
          throw ApiError.validation('币种参数不合法', {
            isoCode: ['必须是 ISO 4217 三位大写字母编码'],
          })
        }
      },
      beforeWrite: async (trx, { action, draft, before }) => {
        if (action !== 'update' || !before) return
        if (before.active !== true || draft.active !== false) return
        const referenced = await trx
          .selectFrom('bas_company')
          .select('id')
          .where('base_currency_id', '=', String(draft.id))
          .executeTakeFirst()
        if (referenced) {
          throw ApiError.validation('币种参数不合法', {
            active: ['已被公司引用为本币,不可停用'],
          })
        }
      },
    },
  })
}

export type CurrencyService = ReturnType<typeof createCurrencyService>
