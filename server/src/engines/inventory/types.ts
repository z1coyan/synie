import type { Decimal } from '@synie/shared'
import type { DbHandle } from '~/db/tx.ts'

/** 过账来源单据头 */
export interface StockVoucher {
  type: string
  id: string
  no: string
  companyId: string
  /** 业务日；Date 或 YYYY-MM-DD / ISO 字符串 */
  postingDate: Date | string
}

export interface StockVoucherRef {
  type: string
  id: string
}

/**
 * 库存分录行：数量带符号、恒物料默认单位口径（6 位精度档）。
 * 正=入、负=出、非零。
 */
export interface StockLine {
  warehouseId: string
  materialId: string
  quantity: Decimal | string | number
  remarks?: string | null
}

export interface BalanceQuery {
  companyId: string
  asOf?: Date | string
  warehouseId?: string | null
  materialId?: string | null
  hideZero?: boolean
}

export interface BalanceRow {
  warehouseId: string
  warehouseName: string
  materialId: string
  materialCode: string
  materialName: string
  materialSpec: string | null
  unitName: string
  quantity: string
}

/** 库存事实引擎接口（DbHandle 由调用方注入；引擎不自起事务） */
export interface InventoryEngine {
  post(db: DbHandle, voucher: StockVoucher, lines: StockLine[]): Promise<void>
  cancel(db: DbHandle, ref: StockVoucherRef, cancelledAt?: Date): Promise<void>
  balance(db: DbHandle, query: BalanceQuery): Promise<BalanceRow[]>
}
