/**
 * 打印装配取值格式化：一律字符串、空值归空串。
 * 显示格式仍由单元格 Excel 格式承载。
 */
import { decimal } from '@synie/shared'

export function formatText(value: string | null | undefined): string {
  return value ?? ''
}

export function formatDecimal(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  return decimal(String(value)).toString()
}

export function formatBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return ''
  return value ? '是' : '否'
}

/** 对齐 Elixir Date.to_iso8601 */
export function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    // date-only or timestamp string from PG
    return value.slice(0, 10)
  }
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 对齐 Elixir NaiveDateTime.to_iso8601（timestamp without time zone） */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    // normalize "2024-01-02 15:04:05" → ISO-like
    const cleaned = value.replace(' ', 'T')
    return cleaned.length >= 19 ? cleaned.slice(0, 19) : cleaned
  }
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  const hh = String(value.getUTCHours()).padStart(2, '0')
  const mm = String(value.getUTCMinutes()).padStart(2, '0')
  const ss = String(value.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`
}

export function formatInt(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

export function enumLabel(labels: Record<string, string>, value: string | null | undefined): string {
  if (!value) return ''
  return labels[value] ?? labels[value.toLowerCase()] ?? labels[value.toUpperCase()] ?? value
}
