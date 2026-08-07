import { isDecimalString } from '@synie/shared'
import type { ListQuery } from '@synie/shared'
import { z } from 'zod'
import { ApiError } from './errors.ts'

/** JSON wire decimal：禁止指数、NaN、Infinity 与任意非十进制文本进入 Decimal 构造器。 */
export const decimalStringSchema = z.string().refine(isDecimalString, {
  message: '必须是十进制字符串',
})

function isDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year === 0 || month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]!
}

/** 业务日 JSON wire：严格 YYYY-MM-DD，并拒绝 2 月 30 日等不存在的日历日期。 */
export const dateOnlySchema = z.string().refine(isDateOnly, {
  message: '必须是有效的 YYYY-MM-DD 日期',
})

/** 列表查询通用 query schema（limit/offset/search/sort/filter） */
export const listQuerySchema = z
  .object({
    limit: z.number().int().min(0).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    search: z.string().optional(),
    sort: z
      .object({ column: z.string(), direction: z.enum(['ascending', 'descending']) })
      .optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

/**
 * zValidator 的统一失败钩子：zod issues → validation 错误模型
 * { fields: { "items.0.qty": ["必填"] } }，路径用点号连接。
 * 参数类型取宽（结构超集），由 zValidator 在调用点收敛到具体 schema。
 */
export function validationHook(result: { success: boolean; error?: z.ZodError }): void {
  if (result.success || !result.error) return
  const fields: Record<string, string[]> = {}
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_'
    ;(fields[key] ??= []).push(issue.message)
  }
  throw ApiError.validation('请求参数错误', fields)
}

/** listQuerySchema → ListQuery 的唯一换算点（各路由不再各自抄一份）。 */
export function toListQuery(body: z.infer<typeof listQuerySchema>): Partial<ListQuery> {
  return {
    limit: body.limit,
    offset: body.offset,
    search: body.search,
    sort: body.sort,
    filter: body.filter as ListQuery['filter'],
  }
}

/**
 * 聚合草稿 wire 的失败钩子：头字段平铺在草案顶层，错误路径回填 `header.` 前缀；
 * 子集合键（默认 items，发货单另有 packBoxes）保持原路径，索引用 [i] 记法。
 */
export function draftValidationHook(childKeys: readonly string[] = ['items']) {
  return (result: { success: boolean; error?: z.ZodError }): void => {
    if (result.success || !result.error) return
    const fields: Record<string, string[]> = {}
    for (const issue of result.error.issues) {
      let key = ''
      for (const part of issue.path) {
        if (typeof part === 'number') key += `[${part}]`
        else key += key ? `.${String(part)}` : String(part)
      }
      if (!key) key = '_'
      else if (!childKeys.some((k) => key.startsWith(k))) key = `header.${key}`
      ;(fields[key] ??= []).push(issue.message)
    }
    throw ApiError.validation('请求参数错误', fields)
  }
}
