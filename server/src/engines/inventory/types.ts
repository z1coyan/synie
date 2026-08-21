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

/**
 * 账面库存查询维度：Σ 未作废分录（无截至日，即当前账面）。
 * materialId 必填；warehouseId / companyId 至少给一项（都给则同时限定）。
 */
export interface OnHandQuery {
  materialId: string
  /** 限定单仓（仓×物料粒度） */
  warehouseId?: string | null
  /** 限定公司（公司全仓合计口径） */
  companyId?: string | null
}

/** 仓内账面行：按物料分组，只含非零行（整仓带出口径同余额视图默认） */
export interface OnHandRow {
  materialId: string
  quantity: Decimal
}

/**
 * 分录存在性查询维度：warehouseId / materialId 至少给一项。
 * 含作废行——用于引用保护（分录只追加不删行，作废行仍引用仓/物料）。
 */
export interface HasEntriesQuery {
  warehouseId?: string | null
  materialId?: string | null
}

/** 库存事实引擎接口（写方法只收 TrxHandle；引擎不自起事务） */
export interface InventoryEngine {
  post(trx: TrxHandle, voucher: StockVoucher, lines: StockLine[]): Promise<void>
  cancel(trx: TrxHandle, ref: StockVoucherRef, cancelledAt?: Date): Promise<void>
  balance(db: DbHandle, query: BalanceQuery): Promise<BalanceRow[]>
  /** 账面原语：Σ 未作废分录（无截至日）；模块取账面一律走这里，不再手写分录求和 */
  onHand(db: DbHandle, query: OnHandQuery): Promise<Decimal>
  /** 仓内账面原语：按物料分组的非零账面行（盘点整仓带出等批量取数用） */
  onHandByMaterial(db: DbHandle, warehouseId: string): Promise<OnHandRow[]>
  /** 分录存在性原语：仓/物料是否已被分录引用（含作废行） */
  hasEntries(db: DbHandle, query: HasEntriesQuery): Promise<boolean>
}
