/**
 * 单据写路径杂项文本工具（platform/posting · W0 T0.4）
 *
 * 收口：
 * - lowerParty：对手类型落库/比较口径（trim + 小写）
 * - runeLen：Unicode 码点长度（与 wire maxLength 语义一致）
 * - withIndexedFields：聚合草稿校验错误字段加路径前缀（可选别名）
 *
 * 不进 platform/standard/fields.ts（后者专管 ResourceMeta wire/db 值转换）。
 * platform 禁止 import `~/modules/*`。
 */
import { ApiError } from '~/platform/http/errors.ts'

/** 对手类型小写口径（与历史 lowerParty / lowerPartyType 同语义） */
export function lowerParty(value: string): string {
  return value.trim().toLowerCase()
}

/** Unicode 码点长度（`[...s].length`，非 UTF-16 code unit） */
export function runeLen(value: string): number {
  return [...value].length
}

/**
 * 捕获 validation ApiError，给 fields 键加 `prefix.` 前缀后重抛。
 * `aliases`：可选字段名映射（如 number→deliveryNo），fulfillment 头用。
 */
export async function withIndexedFields<T>(
  prefix: string,
  run: () => Promise<T>,
  aliases: Record<string, string> = {},
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'validation' || !error.fields) throw error
    const fields = Object.fromEntries(
      Object.entries(error.fields).map(([field, messages]) => [
        `${prefix}.${aliases[field] ?? field}`,
        messages,
      ]),
    )
    throw ApiError.validation(error.message, fields)
  }
}
