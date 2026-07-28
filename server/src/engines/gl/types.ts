import type { Decimal } from '@synie/shared'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'

/** 过账来源单据头（写分录时锁定的业务上下文） */
export interface GlVoucher {
  type: string
  id: string
  no: string
  companyId: string
  /** 过账日期（业务日）；Date 或 YYYY-MM-DD / ISO 字符串 */
  postingDate: Date | string
}

/** 作废/红冲时仅需的单据引用 */
export interface GlVoucherRef {
  type: string
  id: string
}

/**
 * 单行分录入参。
 * debit/credit 走 decimal 口径（Decimal 或十进制字符串）；缺省按 0。
 */
export interface GlEntry {
  accountId: string
  currencyId?: string | null
  debit?: Decimal | string | number
  credit?: Decimal | string | number
  partyType?: string | null
  partyId?: string | null
  remarks?: string | null
  isReversal?: boolean
}

export interface PostOptions {
  /** 允许负数金额（仅红冲路径使用） */
  allowNegative?: boolean
}

/** 引擎对外接口（工厂闭包返回值形状；写方法只收 TrxHandle，引擎不自起事务） */
export interface GlEngine {
  post(trx: TrxHandle, voucher: GlVoucher, entries: GlEntry[], options?: PostOptions): Promise<void>
  cancel(trx: TrxHandle, ref: GlVoucherRef): Promise<void>
  reverse(trx: TrxHandle, ref: GlVoucherRef, postingDate: Date | string): Promise<void>
  /**
   * 形状 + 科目 + 往来对手全量校验（与 post 同一套规则，不写库）。
   * 供单据草稿保存等场景预检。
   */
  validateEntries(
    db: DbHandle,
    companyId: string,
    entries: GlEntry[],
    options?: PostOptions,
  ): Promise<void>
}
