/**
 * 「从装箱清单获取」的 FIFO 分摊纯函数(规格见 docs/业务模块/销售发货.md。
 *
 * 精度纪律:全部数量以「默认单位微量」(base × 10^6 的 BigInt)运算,杜绝浮点误差;
 * 生成行数量 = 分摊 base × 单位换算系数 的精确十进制串——服务端 base = qty ÷ factor
 * 重算(6 位)恰好回到分摊 base,逐物料 Σ 条目 base 与 Σ 装箱 base 分毫不差,
 * 不破坏审核的装箱等式(全有或全无)。
 */

const MICRO = 1_000_000n

/** 十进制串规范化:消掉科学计数法(UI 数字输入的极端情形) */
function normalizeDecimal(raw: string): string {
  const s = raw.trim()
  if (!/[eE]/.test(s)) return s
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
}

/** 十进制串 → { num, scale }:value = num / 10^scale。非法输入按 0 处理 */
export function parseScaled(raw: unknown): { num: bigint; scale: number } {
  const s = normalizeDecimal(String(raw ?? '0'))
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const [int = '0', frac = ''] = body.split('.')
  const digits = `${int}${frac}`.replace(/^0+(?=\d)/, '')
  if (!/^\d+$/.test(digits)) return { num: 0n, scale: 0 }
  const num = BigInt(digits) * (neg ? -1n : 1n)
  return { num, scale: frac.length }
}

/** 十进制串 → 微量(base × 10^6);超过 6 位小数的部分截断(base 口径恒为 6 位) */
export function parseMicros(raw: unknown): bigint {
  const { num, scale } = parseScaled(raw)
  if (num === 0n) return 0n
  if (scale <= 6) return num * 10n ** BigInt(6 - scale)
  return num / 10n ** BigInt(scale - 6)
}

/** 微量 → 十进制串(去尾零) */
export function microsToString(micros: bigint): string {
  const neg = micros < 0n
  const abs = neg ? -micros : micros
  const int = abs / MICRO
  const frac = String(abs % MICRO).padStart(6, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${frac === '' ? '' : `.${frac}`}`
}

/** micros × (num / 10^scale) 的精确十进制串(分母为 10 的幂,必为有限小数) */
export function microsTimesScaled(micros: bigint, num: bigint, scale: number): string {
  const denom = 10n ** BigInt(scale) * MICRO
  const product = micros * num
  const neg = product < 0n
  const abs = neg ? -product : product
  const int = abs / denom
  const fracStr = String(abs % denom).padStart(Number(denom.toString().length - 1), '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${fracStr === '' ? '' : `.${fracStr}`}`
}

/** qty(=qNum/10^qScale) ÷ factor(=fNum/10^fScale) → 微量,四舍五入(同服务端 toDecimalPlaces(6) HALF_UP) */
export function qtyDivFactorToMicros(
  qty: { num: bigint; scale: number },
  factor: { num: bigint; scale: number },
): bigint {
  if (factor.num <= 0n) return 0n
  // base = qty / factor = qNum × 10^fScale / (10^qScale × fNum);再 ×10^6 取微量
  const numerator = qty.num * 10n ** BigInt(factor.scale + 6)
  const denominator = 10n ** BigInt(qty.scale) * factor.num
  // HALF_UP:floor((2×n + d) / (2×d))
  return (2n * numerator + denominator) / (2n * denominator)
}

export interface PackMaterialSum {
  materialId: string
  /** 报表用标签(如 "F(P)-1 铜网") */
  label: string
  packedMicros: bigint
}

export interface FifoCandidate {
  orderItemId: string
  /** YYYY-MM-DD,字典序即可排序 */
  orderDate: string
  orderNo: string
  materialId: string
  unitId: string
  unitName: string
  /** 订单原币代码;'' 表示未知(视为与任何锁币兼容) */
  currencyCode: string
  remainingMicros: bigint
  /** 该订单条目单位的换算系数(默认单位传 1/10^0) */
  factorNum: bigint
  factorScale: number
  orderQty: string | null
  materialCode: string | null
  materialName: string | null
  materialSpec: string | null
  customerPartNo: string | null
}

export interface ExistingItemSum {
  materialId: string
  label: string
  baseMicros: bigint
  /** 该行订单原币代码;'' 表示未知 */
  currencyCode: string
}

export interface GeneratedLine {
  orderItemId: string
  materialId: string
  unitId: string
  unitName: string
  /** 分摊 base × 单位系数的精确十进制串 */
  qty: string
  /** 分摊 base(6 位去尾零),仅展示用,落库由服务端重算 */
  baseQty: string
  orderNo: string | null
  orderQty: string | null
  materialCode: string | null
  materialName: string | null
  materialSpec: string | null
  customerPartNo: string | null
}

export type UnallocatedReason = 'no-candidate' | 'currency-mismatch' | 'shortfall'

export interface UnallocatedEntry {
  materialId: string
  label: string
  reason: UnallocatedReason
  packed: string
  allocated: string
  remainder: string
  /** currency-mismatch 时的整单锁定币种 */
  currencyCode?: string
}

export interface MismatchEntry {
  materialId: string
  label: string
  itemsBase: string
  packedBase: string
}

export interface GenerateReport {
  lines: GeneratedLine[]
  unallocated: UnallocatedEntry[]
  mismatched: MismatchEntry[]
}

function candidateOrder(c: FifoCandidate): string {
  return `${c.orderDate}|${c.orderNo}|${c.orderItemId}`
}

/**
 * 增量补齐(A 语义):已有发货条目的物料整物料跳过;
 * FIFO 分摊(b 规则):候选按订单日期升序(同单按订单号/条目 id 兜底)依次扣未发,
 * 装满一条扣下一条;尾差只分不超,余量进 unallocated;
 * 币种锁定:既有行优先,否则全部候选中最早者定整单,异币种候选排除。
 */
export function generateItemsFromPack(input: {
  packs: PackMaterialSum[]
  candidates: FifoCandidate[]
  existing: ExistingItemSum[]
}): GenerateReport {
  const { packs, candidates, existing } = input
  const report: GenerateReport = { lines: [], unallocated: [], mismatched: [] }

  const existingByMaterial = new Map<string, ExistingItemSum>()
  for (const e of existing) {
    const cur = existingByMaterial.get(e.materialId)
    if (cur) cur.baseMicros += e.baseMicros
    else existingByMaterial.set(e.materialId, { ...e })
  }

  // 第③组:已有条目的物料(含完全无装箱行的)合计 ≠ 装箱汇总 → 仅提醒不动数据
  const packByMaterial = new Map(packs.map((p) => [p.materialId, p]))
  for (const e of existingByMaterial.values()) {
    const packed = packByMaterial.get(e.materialId)?.packedMicros ?? 0n
    if (packed !== e.baseMicros) {
      report.mismatched.push({
        materialId: e.materialId,
        label: e.label,
        itemsBase: microsToString(e.baseMicros),
        packedBase: microsToString(packed),
      })
    }
  }

  const pending = packs.filter((p) => !existingByMaterial.has(p.materialId) && p.packedMicros > 0n)

  // 锁币:既有行优先;否则待生成物料全部候选中最早者的币种;皆空则不锁
  let lockedCurrency = existing.find((e) => e.currencyCode !== '')?.currencyCode ?? ''
  if (lockedCurrency === '' && pending.length > 0) {
    const pendingMaterials = new Set(pending.map((p) => p.materialId))
    const earliest = candidates
      .filter((c) => pendingMaterials.has(c.materialId) && c.currencyCode !== '')
      .sort((a, b) => candidateOrder(a).localeCompare(candidateOrder(b)))[0]
    lockedCurrency = earliest?.currencyCode ?? ''
  }

  for (const pack of pending) {
    const usable = candidates.filter(
      (c) =>
        c.materialId === pack.materialId &&
        c.remainingMicros > 0n &&
        (lockedCurrency === '' || c.currencyCode === '' || c.currencyCode === lockedCurrency),
    )
    if (usable.length === 0) {
      const anyCandidate = candidates.some(
        (c) => c.materialId === pack.materialId && c.remainingMicros > 0n,
      )
      report.unallocated.push({
        materialId: pack.materialId,
        label: pack.label,
        reason: anyCandidate ? 'currency-mismatch' : 'no-candidate',
        packed: microsToString(pack.packedMicros),
        allocated: '0',
        remainder: microsToString(pack.packedMicros),
        ...(anyCandidate ? { currencyCode: lockedCurrency } : {}),
      })
      continue
    }

    usable.sort((a, b) => candidateOrder(a).localeCompare(candidateOrder(b)))
    const available = usable.reduce((sum, c) => sum + c.remainingMicros, 0n)
    let left = pack.packedMicros < available ? pack.packedMicros : available
    const allocated = left

    for (const cand of usable) {
      if (left <= 0n) break
      const share = cand.remainingMicros < left ? cand.remainingMicros : left
      left -= share
      report.lines.push({
        orderItemId: cand.orderItemId,
        materialId: cand.materialId,
        unitId: cand.unitId,
        unitName: cand.unitName,
        qty: microsTimesScaled(share, cand.factorNum, cand.factorScale),
        baseQty: microsToString(share),
        orderNo: cand.orderNo,
        orderQty: cand.orderQty,
        materialCode: cand.materialCode,
        materialName: cand.materialName,
        materialSpec: cand.materialSpec,
        customerPartNo: cand.customerPartNo,
      })
    }

    if (pack.packedMicros > available) {
      report.unallocated.push({
        materialId: pack.materialId,
        label: pack.label,
        reason: 'shortfall',
        packed: microsToString(pack.packedMicros),
        allocated: microsToString(allocated),
        remainder: microsToString(pack.packedMicros - available),
      })
    }
  }

  return report
}
