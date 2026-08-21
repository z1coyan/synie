/**
 * 标准动作内核·wire presenter 派生：ResourceMeta 字段声明 → DTO 规范化映射。
 *
 * 定位：交易/聚合单据的 present* 曾是「字段事实第 4 份声明」（手写逐键
 * `row.x == null ? null : String(row.x)`）。本派生把键集/键序/规范化规则收回
 * meta——键序即 meta.fields 声明序（含 calculated 投影列，排除 printOnly），
 * 模块只留两类钩子：
 *
 * - `fields`：键清单覆盖——并集（如退货条目三侧来源锚点键）与改序
 *   （如履约条目 returnedQty 在 wire 上的既有位置），从各侧 meta 拼接而来，
 *   不重新声明字段类型
 * - `values`：逐键值钩子——计算列回退（remainingReconcilableQty 等）与
 *   历史怪癖（String(null)='null'、boxNo 数字转字符串）的逐字保留
 *
 * 输入域约定：标准服务读侧行（mapRow + 投影 mapExtra 输出，apiName 键）——
 * date 已是 YYYY-MM-DD 字符串、decimal 已是 toFixed 字符串、datetime 为 Date。
 * 规范化幂等；null/undefined 一律映射为 null（手写版对 NOT NULL 列的
 * `?? ''`/`?? 0` 回退在生产行上不可达，不在输入域内）。
 */
import { decimal } from '@synie/shared'
import { toDateOnly } from '~/db/dates.ts'
import type { FieldMeta, ResourceMeta } from '../meta/types.ts'

export interface PresenterHooks {
  /** 键清单覆盖（并集/改序）；缺省 meta.fields 排除 printOnly */
  fields?: readonly FieldMeta[]
  /** 逐键值钩子（计算列回退/怪癖保留），优先于类型规范化 */
  values?: Record<string, (row: Record<string, unknown>) => unknown>
}

/** 类型规范化：与全站 wire 约定一致（decimal toFixed / date YYYY-MM-DD / datetime ISO / enum 大写） */
function presentValue(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null
  switch (field.type) {
    case 'decimal':
      return decimal(String(value)).toFixed()
    case 'date':
      return toDateOnly(value as Date | string)
    case 'datetime':
      return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
    case 'enum':
      return String(value).trim().toUpperCase()
    case 'enumArray':
      return Array.isArray(value) ? value.map((v) => String(v).toUpperCase()) : value
    case 'integer':
      return typeof value === 'number' ? value : Number(value)
    case 'boolean':
      return Boolean(value)
    default:
      // string / uuid / fk
      return String(value)
  }
}

/**
 * 派生 wire presenter：meta 字段序 → DTO。返回类型经泛型锚定到模块 DTO
 * interface（hc 契约），运行时键集/键序/值由 meta 唯一决定。
 */
export function derivePresenter<TDto = Record<string, unknown>>(
  meta: ResourceMeta,
  hooks?: PresenterHooks,
): (row: Record<string, unknown>) => TDto {
  const fields = hooks?.fields ?? meta.fields.filter((f) => !f.printOnly)
  const values = hooks?.values ?? {}
  return (row: Record<string, unknown>): TDto => {
    const dto: Record<string, unknown> = {}
    for (const field of fields) {
      const hook = values[field.apiName]
      dto[field.apiName] = hook ? hook(row) : presentValue(field, row[field.apiName])
    }
    return dto as unknown as TDto
  }
}
