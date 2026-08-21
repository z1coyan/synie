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

// —— 聚合草稿 zod 派生（D8 后续「类型级 wire 派生」）——
//
// 草稿三连（POST 创建 / PUT 整单替换）的 zod 曾是「字段事实第 3 份声明」。
// 与 deriveWireSchemas 的差异（草稿既有 wire 口径，逐字冻结）：
// - string 不 trim/min/maxLength（草稿校验文案由服务层钩子承担）
// - required 语义按草稿而非 CRUD：日期/科目等「服务层兜底必填」字段在 wire 上可空可缺省
// - readonly 编号可手填（nullable optional，空串由服务层拒）；enum 可放宽为 string.min(1)
// 故草稿 schema 不复用 baseSchema，而走下面的 draftBase + 逐字段补丁。

/** 草稿字段补丁：schema 完整替换（enum 放宽/readonly 编号），或包 nullable/optional */
export interface DraftFieldPatch {
  schema?: z.ZodTypeAny
  nullable?: boolean
  optional?: boolean
}

/**
 * 草稿头/子行字段条目：
 * - `'apiName'`：按 meta 派生（required → 原样；否则 optional；不再自动 nullable）
 * - `['apiName', patch]`：meta 派生 + 补丁
 * - `['key', zodSchema]`：字面量（meta 之外的键，如子行 id、三侧来源锚点并集）
 */
export type DraftFieldEntry = string | readonly [string, DraftFieldPatch | z.ZodTypeAny]

/** 草稿字段基型：类型/格式约束来自 meta（与手写草稿 schema 逐字同型） */
function draftBase(meta: ResourceMeta, field: FieldMeta): z.ZodTypeAny {
  switch (field.type) {
    case 'string':
      return z.string()
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
        throw new Error(`草稿派生：资源 ${meta.name} 枚举字段 ${field.apiName} 缺少 options`)
      }
      return z.enum(values as [string, ...string[]])
    }
    case 'uuid':
    case 'fk':
      return z.string().uuid()
    default:
      throw new Error(
        `草稿派生暂不支持字段类型 ${field.type}（资源 ${meta.name} 字段 ${field.apiName}）——该字段用字面量条目`,
      )
  }
}

/**
 * 派生草稿对象 shape（未包 z.object）：条目序即键序（zod issue 顺序与手写一致）。
 */
export function deriveDraftShape(
  meta: ResourceMeta,
  entries: readonly DraftFieldEntry[],
): Record<string, z.ZodTypeAny> {
  const byApi = new Map(meta.fields.map((f) => [f.apiName, f]))
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const field = byApi.get(entry)
      if (!field) throw new Error(`草稿派生：资源 ${meta.name} 无字段 ${entry}`)
      let schema = draftBase(meta, field)
      if (!field.required) schema = schema.optional()
      shape[entry] = schema
      continue
    }
    const [key, patch] = entry
    if (patch instanceof z.ZodType) {
      shape[key] = patch
      continue
    }
    const field = byApi.get(key)
    if (!field) throw new Error(`草稿派生：资源 ${meta.name} 无字段 ${key}`)
    let schema = patch.schema ?? draftBase(meta, field)
    if (patch.nullable) schema = schema.nullable()
    const optional = patch.optional ?? !field.required
    if (optional) schema = schema.optional()
    shape[key] = schema
  }
  return shape
}

/**
 * 派生草稿子树/独立对象 schema（`.strict()`，未知键 422）——子行 schema、
 * 装箱箱/装箱行等经 z.array 挂进头 shape。
 */
export function deriveDraftObject(
  meta: ResourceMeta,
  entries: readonly DraftFieldEntry[],
): z.ZodTypeAny {
  return z.object(deriveDraftShape(meta, entries)).strict()
}

export interface DraftSchemas {
  create: z.ZodTypeAny
  replace: z.ZodTypeAny
}

/**
 * 派生整单草稿 create/replace schema：头字段 + 子树 extras（items/packBoxes，
 * create 可带 `.default([])` 兼容只建表头调用；replace 必须显式全集合）。
 */
export function deriveDraftSchemas(
  meta: ResourceMeta,
  head: readonly DraftFieldEntry[],
  extras: Record<string, { create: z.ZodTypeAny; replace: z.ZodTypeAny }>,
): DraftSchemas {
  const headShape = deriveDraftShape(meta, head)
  const pick = (variant: 'create' | 'replace') => {
    const shape = { ...headShape }
    for (const [key, schemas] of Object.entries(extras)) shape[key] = schemas[variant]
    return z.object(shape).strict()
  }
  return { create: pick('create'), replace: pick('replace') }
}
