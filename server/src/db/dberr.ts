import { ApiError } from '~/platform/http/errors.ts'

export interface PgWriteMapping {
  code?: string
  /** 约束名或错误消息片段（子串匹配） */
  constraint?: string
  message: string
}

/**
 * 将 PostgreSQL 唯一/外键冲突映射为 ApiError（对齐 server-go dberr.MapWrite）。
 * 未匹配的 23505/23503 使用 mappings 中无 constraint 的兜底项；再否则 internal。
 */
export function mapWriteError(
  err: unknown,
  fallbackMessage: string,
  mappings: readonly PgWriteMapping[],
): ApiError {
  if (err instanceof ApiError) return err
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return new ApiError('internal', fallbackMessage, { cause: err })
  }
  const e = err as { code?: string; constraint_name?: string; constraint?: string; message?: string }
  const constraint = e.constraint_name ?? e.constraint ?? ''
  const msg = e.message ?? ''
  if (e.code === '23505' || e.code === '23503') {
    for (const m of mappings) {
      if (m.code && m.code !== e.code) continue
      if (m.constraint) {
        if (!constraint.includes(m.constraint) && !msg.includes(m.constraint)) continue
      }
      return new ApiError('conflict', m.message, { cause: err })
    }
  }
  return new ApiError('internal', fallbackMessage, { cause: err })
}
