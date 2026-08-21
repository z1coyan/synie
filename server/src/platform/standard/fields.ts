/**
 * 标准动作内核·字段派生：ResourceMeta 字段声明 → wire/db 双向值转换与投影。
 *
 * 全站既有约定（枚举大小写两路统一经 platform/meta/enum-storage.ts 换算）：
 * - 枚举 wire 大写、库内随 enumStorage（缺省小写）
 * - decimal wire 十进制字符串、库内 numeric，读回 toFixed 规范化
 * - date wire `YYYY-MM-DD` 字符串；datetime wire Date（DTO 层 toISOString）
 */
import { decimal } from '@synie/shared'
import { toDateOnly } from '~/db/dates.ts'
import { enumDbValue } from '../meta/enum-storage.ts'
import type { AuthzBinding } from '../meta/resource-authz.ts'
import type { FieldMeta, ResourceMeta } from '../meta/types.ts'

/** 平台管理列：任何资源都不可经 wire 写入 */
const MANAGED_COLUMNS = new Set(['id', 'inserted_at', 'updated_at'])

/** 物理字段（排除计算投影列与仅打印列） */
export function physicalFields(meta: ResourceMeta): FieldMeta[] {
  return meta.fields.filter((f) => !f.calculated && !f.printOnly)
}

/**
 * 公司列唯一解析点：由 authz 绑定派生（fail-closed），禁止 `company_id` 字面量查找。
 * 绑定无 company（global 资源）→ undefined；绑定列无对应字段即 seal 漏拦（不变量破坏），抛错。
 * 注意：via 子行不适用本助手——子行公司列是母单绑定列的镜像带入，由 child.ts 按
 * 母单归宿绑定派生并容忍缺列（子行可不带入公司列）。
 */
export function companyFieldOf(meta: ResourceMeta, binding: AuthzBinding): FieldMeta | undefined {
  if (!binding.company) return undefined
  const field = physicalFields(meta).find((f) => f.dbColumn === binding.company!.column)
  if (!field) {
    throw new Error(`标准派生：资源 ${binding.resource} 公司列 ${binding.company.column} 无对应字段`)
  }
  return field
}

/**
 * 可写字段：物理 − readonly − 平台管理列 − 盖章列（created_by/owner_dept 由 authz 绑定盖）。
 */
export function writableFields(meta: ResourceMeta, stampedColumns: ReadonlySet<string>): FieldMeta[] {
  return physicalFields(meta).filter(
    (f) => !f.readonly && !MANAGED_COLUMNS.has(f.dbColumn) && !stampedColumns.has(f.dbColumn),
  )
}

/** wire → db 值（schema 已完成类型/格式校验；此处只做规范化） */
export function toDbValue(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (field.codec) return field.codec.toSnapshot(value)
  switch (field.type) {
    case 'enum':
      // 库内大小写按 meta 声明（缺省小写）；与筛选编译共用同一换算，见 enum-storage.ts
      return enumDbValue(field.enumStorage, String(value))
    case 'enumArray':
      return Array.isArray(value)
        ? value.map((v) => enumDbValue(field.enumStorage, String(v)))
        : value
    case 'decimal':
      return decimal(String(value)).toFixed()
    case 'string':
      return String(value)
    default:
      return value
  }
}

/** db → wire 值 */
export function fromDbValue(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (field.codec) return field.codec.fromDb(value)
  switch (field.type) {
    case 'enum':
      return String(value).toUpperCase()
    case 'enumArray':
      return Array.isArray(value) ? value.map((v) => String(v).toUpperCase()) : value
    case 'decimal':
      return decimal(String(value)).toFixed()
    case 'date':
      return toDateOnly(value as Date | string)
    case 'datetime':
      return value instanceof Date ? value : new Date(String(value))
    case 'boolean':
      return Boolean(value)
    case 'integer':
      return typeof value === 'number' ? value : Number(value)
    case 'uuid':
    case 'fk':
    case 'string':
      return String(value)
    default:
      return value
  }
}

/** db 行 → wire item（键为 apiName） */
export function mapRow(meta: ResourceMeta, row: Record<string, unknown>): Record<string, unknown> {
  const item: Record<string, unknown> = {}
  for (const field of physicalFields(meta)) {
    item[field.apiName] = fromDbValue(field, row[field.dbColumn])
  }
  return item
}

/**
 * wire item → 审计快照（键为 dbColumn，值为 db 规范形）。
 * 白名单由 audit/spec.ts 派生；快照只收白名单内字段，语义与存量手写 snapshot 一致。
 */
export function snapshot(
  meta: ResourceMeta,
  item: Record<string, unknown>,
  auditFields: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(auditFields)
  const snap: Record<string, unknown> = {}
  for (const field of physicalFields(meta)) {
    if (!allowed.has(field.dbColumn)) continue
    snap[field.dbColumn] = toDbValue(field, item[field.apiName])
  }
  return snap
}

/** wire item → HTTP DTO（datetime 转 ISO 字符串，其余原样；投影附加键透传） */
export function toDto(meta: ResourceMeta, item: Record<string, unknown>): Record<string, unknown> {
  const physical = new Set<string>()
  const dto: Record<string, unknown> = {}
  for (const field of physicalFields(meta)) {
    physical.add(field.apiName)
    const value = item[field.apiName]
    dto[field.apiName] = field.type === 'datetime' && value instanceof Date ? value.toISOString() : value
  }
  for (const [key, value] of Object.entries(item)) {
    if (physical.has(key) || value === undefined) continue
    dto[key] = value instanceof Date ? value.toISOString() : value
  }
  return dto
}
