/**
 * 订单金额链：原币金额=数量×单价(2)；本币单价=单价×汇率(4)；本币金额=原币金额×汇率(2)。
 * half-up（负数远离零），对齐 amount_chain golden。
 */
import { decimal, roundAmount, roundBasePrice, type Decimal } from '@synie/shared'

export interface AmountFields {
  qty: Decimal
  price: Decimal
  amount: Decimal
  basePrice: Decimal
  baseAmount: Decimal
}

export function deriveItemAmounts(qty: Decimal | string, price: Decimal | string, exchangeRate: Decimal | string): {
  amount: Decimal
  basePrice: Decimal
  baseAmount: Decimal
} {
  const q = decimal(qty)
  const p = decimal(price)
  const rate = decimal(exchangeRate)
  const amount = decimal(roundAmount(q.mul(p)))
  const basePrice = decimal(roundBasePrice(p.mul(rate)))
  const baseAmount = decimal(roundAmount(amount.mul(rate)))
  return { amount, basePrice, baseAmount }
}
