import Decimal from 'decimal.js'

// 金额纪律（对齐迁移定案 KD7 与 server-go 的 shopspring/decimal 行为）：
// - wire 一律字符串十进制，禁止 JSON number 表示金额/数量
// - 舍入恒为 half-up（half away from zero），与 Elixir/Go 两版一致
// - 精度档位：金额 2 位、本币单价 4 位、base 数量 6 位（见 docs/术语表.md 金额链）
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, toExpPos: 100, toExpNeg: -100 })

export { Decimal }

/** 十进制字符串品牌类型：服务端/前端 JSON 边界上的金额与数量口径 */
export type DecimalString = string & { readonly __brand: 'DecimalString' }

export const DECIMAL_SCALE = {
  /** 金额（原币/本币行金额） */
  amount: 2,
  /** 本币单价（仅展示参考） */
  basePrice: 4,
  /** base 数量（默认单位口径） */
  baseQty: 6,
} as const

const DECIMAL_RE = /^-?[0-9]+(?:\.[0-9]+)?$/

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value)
}

export function decimal(value: string | number | Decimal): Decimal {
  return new Decimal(value)
}

/** 定点输出（非科学计数法），对齐 shopspring Decimal.String() 的 wire 形态 */
export function toDecimalString(value: Decimal): DecimalString {
  return value.toFixed() as DecimalString
}

/** 按档位舍入（half-up）并输出定点字符串 */
export function roundTo(value: Decimal | string | number, scale: number): DecimalString {
  return new Decimal(value).toFixed(scale) as DecimalString
}

export const roundAmount = (value: Decimal | string | number): DecimalString => roundTo(value, DECIMAL_SCALE.amount)
export const roundBasePrice = (value: Decimal | string | number): DecimalString => roundTo(value, DECIMAL_SCALE.basePrice)
export const roundBaseQty = (value: Decimal | string | number): DecimalString => roundTo(value, DECIMAL_SCALE.baseQty)
