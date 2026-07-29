/**
 * 装箱行箱号自动递增(规格 .scratch/delivery-pack-first-ux 追加定案 2026-07-29):
 * 一物料拆多箱为装箱常态,新增行默认 = 上一行箱号尾数 +1。
 * 规则:尾部数字 +1,保留前缀与补零宽度(宽度可自然增长);尾无数字则追加 "-01"。
 */

export function nextBoxNo(last: string): string {
  const trimmed = last.trim()
  if (trimmed === '') return '1'
  const match = /^(.*?)(\d+)$/.exec(trimmed)
  if (!match) return `${trimmed}-01`
  const [, prefix, digits] = match
  const next = String(BigInt(digits!) + 1n)
  // 保留补零宽度(01→02);位数自然增长时不截断(09→10、99→100)
  const padded = next.length < digits!.length ? next.padStart(digits!.length, '0') : next
  return `${prefix}${padded}`
}
