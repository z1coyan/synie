import type { z } from 'zod'
import { ApiError } from './errors.ts'

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
