/** 金额千分位两位小数;空值回空串,非数值原样字符串化 */
export function formatAmount(value: unknown): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 单价千分位:最少 2 位、最多 4 位小数(本币单价 4 位精度先例);空值回空串 */
export function formatPrice(value: unknown): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

/** 数量千分位、去尾零:默认最多 6 位小数(默认单位 base 量 6 位精度);
 * 窄空间(如进度格)可传 maxFractionDigits=4(行单位换算回的长小数截断);
 * 空值回空串,非数值原样字符串化,同 formatAmount 纪律 */
export function formatQty(value: unknown, maxFractionDigits = 6): string {
  if (value == null || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value)
  return n.toLocaleString('zh-CN', { maximumFractionDigits: maxFractionDigits })
}

const DIGITS = '零壹贰叁肆伍陆柒捌玖'
const UNITS = ['', '拾', '佰', '仟']
const GROUPS = ['', '万', '亿', '万亿']

function segmentInWords(seg: number): string {
  let out = ''
  let pendingZero = false
  for (let u = 3; u >= 0; u--) {
    const d = Math.floor(seg / 10 ** u) % 10
    if (d === 0) {
      if (out) pendingZero = true
      continue
    }
    if (pendingZero) {
      out += '零'
      pendingZero = false
    }
    out += DIGITS[d] + UNITS[u]
  }
  return out
}

function integerInWords(n: number): string {
  const segs: number[] = []
  while (n > 0) {
    segs.push(n % 10000)
    n = Math.floor(n / 10000)
  }
  let out = ''
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (seg === 0) {
      if (out && !out.startsWith('零')) out = '零' + out
      continue
    }
    if (out && segs[i - 1]! > 0 && segs[i - 1]! < 1000 && !out.startsWith('零')) out = '零' + out
    out = segmentInWords(seg) + GROUPS[i] + out
  }
  return out
}

/** 人民币中文大写:元角分,负数冠「负」,无角有分补「零」,无角无分尾「整」 */
export function amountInWords(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  if (n < 0) return `负${amountInWords(-n)}`
  const cents = Math.round(n * 100)
  if (cents === 0) return '零元整'
  const yuan = Math.floor(cents / 100)
  const jiao = Math.floor(cents / 10) % 10
  const fen = cents % 10

  let out = yuan > 0 ? `${integerInWords(yuan)}元` : ''
  if (jiao === 0 && fen === 0) return `${out}整`
  if (jiao > 0) out += `${DIGITS[jiao]}角`
  else if (yuan > 0 && fen > 0) out += '零'
  if (fen > 0) out += `${DIGITS[fen]}分`
  return out
}
