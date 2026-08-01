import Decimal from 'decimal.js'

// 金额纪律（对齐迁移定案 KD7 与 server-go 的 shopspring/decimal 行为）：
// - wire 一律字符串十进制，禁止 JSON number 表示金额/数量
// - 舍入恒为 half-up（half away from zero），与 Elixir/Go 两版一致
// - 精度档位：金额 2 位、本币单价 4 位、base 数量 6 位（见 CONTEXT.md 金额链）
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

export const INT64_MIN = -9_223_372_036_854_775_808n
export const INT64_MAX = 9_223_372_036_854_775_807n

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

function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new RangeError('decimal scale 必须是 0..18 的整数')
  }
}

/**
 * DecimalString → Convex v.int64。输入先按 half-up 舍入到声明 scale；任何
 * 超出 signed int64 或 manifest 业务上限的值都 fail-closed。
 */
export function decimalToScaledInt64(
  value: string,
  scale: number,
  options: { maxAbsScaled?: bigint } = {},
): bigint {
  assertScale(scale)
  if (!isDecimalString(value)) throw new TypeError('值必须是十进制字符串')
  const shifted = new Decimal(value)
    .toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
    .mul(new Decimal(10).pow(scale))
  const encoded = BigInt(shifted.toFixed(0))
  if (encoded < INT64_MIN || encoded > INT64_MAX) {
    throw new RangeError('十进制值超出 signed int64 范围')
  }
  const maxAbs = options.maxAbsScaled
  if (maxAbs !== undefined) {
    if (maxAbs < 0n || maxAbs > INT64_MAX) throw new RangeError('maxAbsScaled 非法')
    if (encoded < -maxAbs || encoded > maxAbs) {
      throw new RangeError('十进制值超出业务范围')
    }
  }
  return encoded
}

/** Convex v.int64 → 非科学计数法 DecimalString；去掉无意义尾零。 */
export function scaledInt64ToDecimal(value: bigint, scale: number): DecimalString {
  assertScale(scale)
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new RangeError('scaled value 超出 signed int64 范围')
  }
  if (scale === 0) return value.toString() as DecimalString
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const integer = digits.slice(0, -scale)
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  const body = fraction ? `${integer}.${fraction}` : integer
  return `${negative ? '-' : ''}${body}` as DecimalString
}
