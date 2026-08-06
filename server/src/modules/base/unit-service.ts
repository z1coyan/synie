/**
 * 计量单位（全局主数据，无公司列）——标准派生服务。
 *
 * CRUD/批量/审计/授权全部由 platform/standard 按 meta 派生；
 * 本文件只声明领域不变量（钩子）与约束文案。
 */
import { decimal } from '@synie/shared'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { DB as Database } from '~/db/types.ts'
import { ApiError } from '~/platform/http/errors.ts'
import type { Registry } from '~/platform/meta/registry.ts'
import { createStandardService, type StandardService } from '~/platform/standard/service.ts'
import { UNIT_RESOURCE_NAME } from './meta.ts'

export interface Unit {
  id: string
  unitType: 'LENGTH' | 'AREA' | 'WEIGHT' | 'QUANTITY'
  isBase: boolean
  name: string
  symbol: string
  ratio: string
  insertedAt: Date
  updatedAt: Date
  [key: string]: unknown
}

export function createUnitService(db: Kysely<Database>, registry: Registry): StandardService<Unit> {
  return createStandardService<Unit>({
    db,
    registry,
    resource: UNIT_RESOURCE_NAME,
    notFound: '计量单位不存在',
    defaultOrder: sql`"unit_type", "name", "id"`,
    writeErrors: [
      { code: '23505', constraint: 'base_per_type', message: '该类型已存在基准单位' },
      { code: '23505', message: '单位符号已存在' },
      { code: '23503', message: '计量单位已被业务数据引用,不可删除' },
    ],
    hooks: {
      validate: ({ draft }) => {
        const ratio = decimal(String(draft.ratio))
        // decimal.js isPositive() 对 0 仍可能为 true（符号位 +），用 gt(0) 判严格正
        if (!ratio.gt(0)) {
          throw ApiError.validation('计量单位参数不合法', { ratio: ['换算比例必须大于 0'] })
        }
        if (draft.isBase === true && !ratio.equals(1)) {
          throw ApiError.validation('计量单位参数不合法', { ratio: ['基准单位换算比例必须为 1'] })
        }
      },
    },
  })
}

export type UnitService = ReturnType<typeof createUnitService>
