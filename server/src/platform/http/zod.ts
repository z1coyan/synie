import { isDecimalString } from '@synie/shared'
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
