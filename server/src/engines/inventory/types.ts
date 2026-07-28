import type { Decimal } from '@synie/shared'
import type { DbHandle, TrxHandle } from '~/db/tx.ts'

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

/** 库存变动方向：in=入库（正）、out=出库（负）；符号由引擎按 direction 计算 */
export type StockDirection = 'in' | 'out'

/**
 * 库存分录行：数量为绝对值（大于零），方向进 direction；
 * 恒物料默认单位口径（6 位精度档）。
 */
export interface StockLine {
  warehouseId: string
  materialId: string
  /** 数量绝对值（必须 > 0）；禁止手写负号 */
  quantity: Decimal | string
  direction: StockDirection
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

/** 库存事实引擎接口（写方法只收 TrxHandle；引擎不自起事务） */
export interface InventoryEngine {
  post(trx: TrxHandle, voucher: StockVoucher, lines: StockLine[]): Promise<void>
  cancel(trx: TrxHandle, ref: StockVoucherRef, cancelledAt?: Date): Promise<void>
  balance(db: DbHandle, query: BalanceQuery): Promise<BalanceRow[]>
}
