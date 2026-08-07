/**
 * 标准动作内核·wire schema 派生：ResourceMeta 字段声明 → create/update zod schema。
 *
 * 规则（唯一事实源是 FieldMeta）：
 * - required：create 必填非空；update 可缺省但不可 null
 * - nullable：wire 可显式写 null（清空），列可空才可声明
 * - createOnly：只进 create schema，update 不可写
 * - maxLength：按 Unicode 码点计数（与存量 runeLen 语义一致）
 * - 未支持的字段类型（json/enumArray）注册期即抛错——fail-closed，
 *   有此类字段的资源应弹射该动作回手写
 */
import { z } from 'zod'
import { dateOnlySchema, decimalStringSchema } from '~/platform/http/zod.ts'
import type { FieldMeta, ResourceMeta } from '../meta/types.ts'
import { writableFields } from './fields.ts'

export interface WireSchemas {
  create: z.ZodTypeAny
  update: z.ZodTypeAny
}

function baseSchema(meta: ResourceMeta, field: FieldMeta): z.ZodTypeAny {
  switch (field.type) {
    case 'string': {
      let schema = z.string().trim()
      if (field.required) schema = schema.min(1, '不能为空')
      if (field.maxLength !== undefined) {
        const max = field.maxLength
        return schema.refine((v) => [...v].length <= max, `最多 ${max} 个字符`)
      }
      return schema
    }
    case 'decimal':
      return decimalStringSchema
    case 'boolean':
      return z.boolean()
    case 'integer':
      return z.number().int()
    case 'date':
      return dateOnlySchema
    case 'enum': {
      const values = (field.enumOptions ?? []).map((o) => o.value)
      if (values.length === 0) {
        throw new Error(`标准派生：资源 ${meta.name} 枚举字段 ${field.apiName} 缺少 options`)
      }
      return z.enum(values as [string, ...string[]])
    }
    case 'enumArray': {
      const values = (field.enumOptions ?? []).map((o) => o.value)
      if (values.length === 0) {
        throw new Error(`标准派生：资源 ${meta.name} 枚举数组字段 ${field.apiName} 缺少 options`)
      }
      return z.array(z.enum(values as [string, ...string[]]))
    }
    case 'uuid':
    case 'fk':
      return z.string().uuid()
    default:
      throw new Error(
        `标准派生暂不支持字段类型 ${field.type}（资源 ${meta.name} 字段 ${field.apiName}）——该资源应弹射回手写服务`,
      )
  }
}

/**
 * 派生 create/update schema。均为 `.strict()`：未知键即 422（与存量手写 schema 一致）。
 */
export function deriveWireSchemas(meta: ResourceMeta, stampedColumns: ReadonlySet<string>): WireSchemas {
  const createShape: Record<string, z.ZodTypeAny> = {}
  const updateShape: Record<string, z.ZodTypeAny> = {}
  for (const field of writableFields(meta, stampedColumns)) {
    const base = baseSchema(meta, field)
    if (field.required) {
      createShape[field.apiName] = base
      if (!field.createOnly) updateShape[field.apiName] = base.optional()
    } else {
      const optional = field.nullable ? base.nullable().optional() : base.optional()
      createShape[field.apiName] = optional
      if (!field.createOnly) updateShape[field.apiName] = optional
    }
  }
  return {
    create: z.object(createShape).strict(),
    update: z.object(updateShape).strict(),
  }
}
