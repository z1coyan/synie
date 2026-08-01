/**
 * xlsx = zip 容器：用 fflate 解包/重打包（禁止 exceljs 全量重写）。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

export type ZipParts = Map<string, Uint8Array>

export function cleanPartName(name: string): string {
  return name.replace(/^\/+/, '').replace(/\\/g, '/')
}

export function unzipParts(data: Uint8Array): ZipParts {
  const raw = unzipSync(data)
  const parts = new Map<string, Uint8Array>()
  for (const [name, bytes] of Object.entries(raw)) {
    if (!bytes) continue
    parts.set(cleanPartName(name), bytes)
  }
  return parts
}

/** 按 order 优先、其余按名序追加，重打包为 deflate zip */
export function zipParts(parts: ZipParts, order: string[] = []): Uint8Array {
  const record: Record<string, Uint8Array> = {}
  const known = new Set<string>()
  for (const name of order) {
    const data = parts.get(name)
    if (data) {
      record[name] = data
      known.add(name)
    }
  }
  const extra = [...parts.keys()].filter((n) => !known.has(n)).sort()
  for (const name of extra) {
    const data = parts.get(name)
    if (data) record[name] = data
  }
  return zipSync(record, { level: 6 })
}

export function partText(parts: ZipParts, name: string): string | undefined {
  const data = parts.get(name)
  return data ? strFromU8(data) : undefined
}

export function setPartText(parts: ZipParts, name: string, text: string): void {
  parts.set(name, strToU8(text))
}

export function bytesToText(data: Uint8Array): string {
  return strFromU8(data)
}

export function textToBytes(text: string): Uint8Array {
  return strToU8(text)
}
