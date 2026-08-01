/** Small deterministic ZIP helpers shared by bank imports and print builders. */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

export type ZipParts = Map<string, Uint8Array>

export function cleanPartName(name: string): string {
  return name.replace(/^\/+/, '').replace(/\\/g, '/')
}

export function unzipParts(data: Uint8Array): ZipParts {
  const raw = unzipSync(data)
  const parts = new Map<string, Uint8Array>()
  for (const [name, bytes] of Object.entries(raw)) {
    if (bytes) parts.set(cleanPartName(name), bytes)
  }
  return parts
}

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
  for (const name of [...parts.keys()].filter((item) => !known.has(item)).sort()) {
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
