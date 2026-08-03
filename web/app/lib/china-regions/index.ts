/**
 * 中国省市区数据（modood/Administrative-divisions-of-China pca-code）。
 * 仅作前端级联选择权威；地址行落库存中文名，不存区划码。
 */
import raw from './pca-code.json'

export interface ChinaRegionNode {
  code: string
  name: string
  children?: ChinaRegionNode[]
}

export const CHINA_PROVINCES = raw as ChinaRegionNode[]

export function citiesOf(provinceName: string | null | undefined): ChinaRegionNode[] {
  if (!provinceName) return []
  return CHINA_PROVINCES.find((p) => p.name === provinceName)?.children ?? []
}

export function districtsOf(
  provinceName: string | null | undefined,
  cityName: string | null | undefined,
): ChinaRegionNode[] {
  if (!provinceName || !cityName) return []
  return citiesOf(provinceName).find((c) => c.name === cityName)?.children ?? []
}

/** 列表/只读：省市区 + 门牌 */
export function formatChinaAddress(parts: {
  province?: string | null
  city?: string | null
  district?: string | null
  address?: string | null
}): string {
  const region = [parts.province, parts.city, parts.district]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean)
  // 直辖市常见「市辖区」层展示时省略，避免「北京市市辖区东城区」拗口
  const compact =
    region.length >= 2 && region[1] === '市辖区'
      ? [region[0], ...region.slice(2)]
      : region
  const detail = parts.address == null ? '' : String(parts.address).trim()
  return [...compact, detail].filter(Boolean).join(' ')
}
